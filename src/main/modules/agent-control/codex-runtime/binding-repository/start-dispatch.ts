import { CodexBindingRepositoryError } from '../codex-binding-error'
import { digestCanonicalJson } from '../codex-model-gateway-contract'
import { normalizeCodexThread, normalizeCodexTurn } from '../codex-native-runtime'
import { sameCodexThreadDirectory } from '../codex-thread-directory-identity'
import type { CodexBindingContext } from './context'
import { requireThread, requireTurn } from './core'
import { recordSettledForkSourceArchiveIntentInOpenTransaction } from './native-history'
import { changes, digest, isPinnedReadOnlySandbox, isRecord, nonEmpty, safePositive } from './shared'
import type { StartMethod, ThreadBindingRow, TurnBindingRow } from './types'

// Thread and turn start dispatch, acceptance and late responses.

export function activateStartDispatch(context: CodexBindingContext, input: {
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
    | {
        method: 'thread/start' | 'thread/fork'
        expectedCwd: string
        expectedParentThreadId: string | null
        expectedForkedFromId: string | null
        expectedPrefixTurnIds: string[]
        materializationRequestDigest: string | null
      }
    | { method: 'turn/start'; threadId: string; clientUserMessageId: string }
} {
  nonEmpty(input.connectionEpoch, 'connection_epoch_invalid')
  nonEmpty(input.bindingLookupKey, 'binding_lookup_invalid')
  nonEmpty(input.requestDigest, 'request_digest_invalid')
  safePositive(input.rpcId, 'rpc_identity_invalid')
  return context.immediate(() => {
    if (input.method !== 'turn/start') {
      const row = context.db.prepare(`
          SELECT * FROM codex_thread_bindings
           WHERE ${input.method === 'thread/start' ? 'isolated_thread_cwd' : 'thread_binding_id'} = ?
        `).get<ThreadBindingRow>(input.bindingLookupKey)
      if (
        !row
        || !row.thread_start_reservation_set_id
        || !row.thread_start_reservation_member_id
        || !row.isolated_thread_cwd
        || row.thread_start_reservation_released_at
        || row.thread_start_dispatch_intent_at
        || (input.method === 'thread/fork'
          && (row.thread_materialization_kind !== 'native_fork'
            || row.materialization_state !== 'pending'
            || !row.history_source_thread_binding_id))
        || (input.method === 'thread/start'
          && row.thread_materialization_kind !== 'fresh_start'
          && row.thread_materialization_kind !== 'fresh_root_with_tail')
      ) {
        throw new CodexBindingRepositoryError('thread_start_not_dispatchable')
      }
      const updated = context.db.prepare(`
          UPDATE codex_thread_bindings
             SET thread_start_rpc_connection_epoch = ?, thread_start_rpc_id = ?,
                 thread_start_request_digest = ?,
                 thread_start_dispatch_intent_at = ?, revision = revision + 1, updated_at = ?
           WHERE thread_binding_id = ? AND revision = ?
             AND thread_start_dispatch_intent_at IS NULL
             AND thread_start_reservation_released_at IS NULL
        `).run(
        input.connectionEpoch,
        input.rpcId,
        input.requestDigest,
        input.dispatchedAt,
        input.dispatchedAt,
        row.thread_binding_id,
        row.revision,
      )
      if (changes(updated) !== 1) throw new CodexBindingRepositoryError('start_dispatch_cas_failed')
      const readback = requireThread(context, row.thread_binding_id)
      if (
        readback.thread_start_rpc_connection_epoch !== input.connectionEpoch
        || readback.thread_start_rpc_id !== input.rpcId
        || readback.thread_start_request_digest !== input.requestDigest
      ) throw new CodexBindingRepositoryError('start_dispatch_readback_mismatch')
      return {
        bindingId: row.thread_binding_id,
        reservationSetId: row.thread_start_reservation_set_id,
        reservationId: row.thread_start_reservation_member_id,
        inboundIdentity: {
          method: input.method,
          expectedCwd: row.isolated_thread_cwd,
          expectedParentThreadId: null,
          expectedForkedFromId: input.method === 'thread/fork'
            ? requireThread(context, row.history_source_thread_binding_id as string).codex_thread_id
            : null,
          expectedPrefixTurnIds: input.method === 'thread/fork'
            ? context.self.readNativeForkMaterialization(row.thread_binding_id)?.expectedPrefixTurnIds || []
            : [],
          materializationRequestDigest: input.method === 'thread/fork'
            ? row.materialization_request_digest
            : null,
        },
      }
    }
    const row = context.db.prepare(`
        SELECT * FROM codex_turn_bindings WHERE ready_run_id = ?
      `).get<TurnBindingRow>(input.bindingLookupKey)
    if (
      !row
      || row.turn_start_reservation_released_at
      || row.turn_start_dispatch_intent_at
      || !row.codex_thread_id
    ) throw new CodexBindingRepositoryError('turn_start_not_dispatchable')
    const updated = context.db.prepare(`
        UPDATE codex_turn_bindings
           SET turn_start_rpc_connection_epoch = ?, turn_start_rpc_id = ?,
               turn_start_request_digest = ?,
               turn_start_dispatch_intent_at = ?, revision = revision + 1, updated_at = ?
         WHERE ready_run_id = ? AND revision = ?
           AND turn_start_dispatch_intent_at IS NULL
           AND turn_start_reservation_released_at IS NULL
      `).run(
      input.connectionEpoch,
      input.rpcId,
      input.requestDigest,
      input.dispatchedAt,
      input.dispatchedAt,
      row.ready_run_id,
      row.revision,
    )
    if (changes(updated) !== 1) throw new CodexBindingRepositoryError('start_dispatch_cas_failed')
    const readback = requireTurn(context, row.ready_run_id)
    if (
      readback.turn_start_rpc_connection_epoch !== input.connectionEpoch
      || readback.turn_start_rpc_id !== input.rpcId
      || readback.turn_start_request_digest !== input.requestDigest
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

export function markStartChildWriteConfirmed(context: CodexBindingContext, input: {
  connectionEpoch: string
  rpcId: number
  method: StartMethod
  bindingId: string
  childWriteDigest: string
  confirmedAt: string
}): void {
  context.immediate(() => {
    const descriptor = startDescriptor(context, input.method)
    const row = requireStartRow(context, input.method, input.bindingId)
    assertStartRpc(context, row, descriptor, input)
    const priorAt = row[descriptor.writeAt] as string | null
    const priorDigest = row[descriptor.writeDigest] as string | null
    if (priorAt || priorDigest) {
      if (priorDigest !== input.childWriteDigest) {
        throw new CodexBindingRepositoryError('child_write_digest_conflict')
      }
      return
    }
    const result = context.db.prepare(`
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

export function validateUnresolvedStart(context: CodexBindingContext, input: {
  connectionEpoch: string
  rpcId: number
  method: StartMethod
  bindingId: string
}): void {
  const descriptor = startDescriptor(context, input.method)
  const row = requireStartRow(context, input.method, input.bindingId)
  assertStartRpc(context, row, descriptor, input)
  if (row[descriptor.releaseAt] !== null) {
    throw new CodexBindingRepositoryError('unresolved_start_already_released')
  }
}

export function reconcileStartAccepted(context: CodexBindingContext, input: {
  connectionEpoch: string
  rpcId: number
  method: StartMethod
  bindingId: string
  nativeId: string
  nativeResult: unknown
  responseDigest: string
  responsePending: boolean
  reconciledAt: string
  forkRecoveryEvidence?: {
    connectionEpoch: string
    preResumeThreadReadDigest: string
    resumedThreadDigest: string
  }
}): void {
  nonEmpty(input.nativeId, 'native_identity_invalid')
  nonEmpty(input.responseDigest, 'response_digest_invalid')
  const method = input.method
  context.immediate(() => {
    if (method !== 'turn/start') {
      reconcileThreadAccepted(context, { ...input, method })
    } else {
      reconcileTurnAccepted(context, input)
    }
  })
}

export function consumeLateStartResponse(context: CodexBindingContext, input: {
  connectionEpoch: string
  rpcId: number
  method: StartMethod
  nativeId: string
  responseDigest: string
  closedAt: string
}): boolean {
  return context.immediate(() => {
    const descriptor = startDescriptor(context, input.method)
    const row = context.db.prepare(`
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
    const result = context.db.prepare(`
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

export function closeLateResponseGuardsForConnection(context: CodexBindingContext, connectionEpoch: string, closedAt: string): number {
  nonEmpty(connectionEpoch, 'connection_epoch_invalid')
  return context.immediate(() => {
    const threadResult = context.db.prepare(`
        UPDATE codex_thread_bindings
           SET thread_start_late_response_guard_closed_at = ?,
               thread_start_late_response_guard_close_reason = 'connection_closed',
               revision = revision + 1, updated_at = ?
         WHERE thread_start_rpc_connection_epoch = ?
           AND thread_start_reconciled_at IS NOT NULL
           AND thread_start_response_at IS NULL
           AND thread_start_late_response_guard_closed_at IS NULL
      `).run(closedAt, closedAt, connectionEpoch)
    const turnResult = context.db.prepare(`
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

export function readStartInboundIdentity(
  context: CodexBindingContext,
  method: StartMethod,
  bindingId: string,
):
  | {
      method: 'thread/start' | 'thread/fork'
      expectedCwd: string
      expectedParentThreadId: string | null
      expectedForkedFromId: string | null
      expectedPrefixTurnIds: string[]
      materializationRequestDigest: string | null
    }
  | { method: 'turn/start'; threadId: string; clientUserMessageId: string } {
  if (method === 'thread/start' || method === 'thread/fork') {
    const row = requireThread(context, bindingId)
    if (!row.isolated_thread_cwd || !row.thread_start_reservation_set_id) {
      throw new CodexBindingRepositoryError('thread_start_not_admitted')
    }
    const sourceThreadId = method === 'thread/fork' && row.history_source_thread_binding_id
      ? requireThread(context, row.history_source_thread_binding_id).codex_thread_id
      : null
    return {
      method,
      expectedCwd: row.isolated_thread_cwd,
      expectedParentThreadId: null,
      expectedForkedFromId: sourceThreadId,
      expectedPrefixTurnIds: method === 'thread/fork'
        ? context.self.readNativeForkMaterialization(row.thread_binding_id)?.expectedPrefixTurnIds || []
        : [],
      materializationRequestDigest: method === 'thread/fork'
        ? row.materialization_request_digest
        : null,
    }
  }
  const row = requireTurn(context, bindingId)
  if (!row.codex_thread_id) throw new CodexBindingRepositoryError('turn_thread_identity_missing')
  return {
    method,
    threadId: row.codex_thread_id,
    clientUserMessageId: row.turn_request_id,
  }
}

export function quarantineStartInbound(context: CodexBindingContext, input: {
  method: StartMethod
  bindingId: string
  reason: string
  quarantinedAt: string
}): void {
  nonEmpty(input.bindingId, 'start_inbound_binding_invalid')
  nonEmpty(input.reason, 'start_inbound_unknown_reason_invalid')
  nonEmpty(input.quarantinedAt, 'start_inbound_unknown_time_invalid')
  context.immediate(() => {
    if (input.method === 'thread/fork') {
      const row = requireThread(context, input.bindingId)
      if (row.thread_materialization_kind !== 'native_fork'
        || (row.materialization_state !== 'pending' && row.materialization_state !== 'unknown')) {
        throw new CodexBindingRepositoryError('fork_materialization_not_pending')
      }
      const evidenceDigest = digestCanonicalJson({
        threadBindingId: input.bindingId,
        reason: input.reason,
        quarantinedAt: input.quarantinedAt,
      })
      const updated = context.db.prepare(`
          UPDATE codex_thread_bindings
             SET materialization_state = 'unknown', materialization_evidence_digest = ?,
                 action_projection_sequence = action_projection_sequence + 1,
                 revision = revision + 1, updated_at = ?
           WHERE thread_binding_id = ? AND revision = ?
             AND materialization_state = 'pending'
        `).run(evidenceDigest, input.quarantinedAt, input.bindingId, row.revision)
      if (changes(updated) !== 1 && row.materialization_state !== 'unknown') {
        throw new CodexBindingRepositoryError('fork_materialization_unknown_cas_failed')
      }
      return
    }
    const readyRunId = input.method === 'turn/start'
      ? input.bindingId
      : context.self.readProductRunForThreadBinding(input.bindingId)
    const turn = requireTurn(context, readyRunId)
    const descriptor = startDescriptor(context, input.method)
    const start = requireStartRow(context, input.method, input.bindingId)
    if (start[descriptor.intent] === null) {
      throw new CodexBindingRepositoryError('start_inbound_not_dispatched')
    }
    const fence = context.db.prepare(`
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
    const updated = context.db.prepare(`
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

export function assertStartFenceNotQuarantined(context: CodexBindingContext, threadBindingId: string, readyRunId: string): void {
  const fence = context.db.prepare(`
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

export function reconcileThreadAccepted(context: CodexBindingContext, input: {
  method: 'thread/start' | 'thread/fork'
  connectionEpoch: string
  rpcId: number
  bindingId: string
  nativeId: string
  nativeResult: unknown
  responseDigest: string
  responsePending: boolean
  reconciledAt: string
  forkRecoveryEvidence?: {
    connectionEpoch: string
    preResumeThreadReadDigest: string
    resumedThreadDigest: string
  }
}): void {
  if (!isRecord(input.nativeResult)) throw new CodexBindingRepositoryError('thread_result_invalid')
  const thread = normalizeCodexThread(input.nativeResult.thread)
  const instructionSources = input.nativeResult.instructionSources ?? []
  const row = requireThread(context, input.bindingId)
  assertStartRpc(context, row, startDescriptor(context, input.method), input)
  const isFork = input.method === 'thread/fork'
  if (isFork !== (row.thread_materialization_kind === 'native_fork')) {
    throw new CodexBindingRepositoryError('thread_materialization_method_mismatch')
  }
  if (!isFork) {
    assertStartFenceNotQuarantined(
      context,
      row.thread_binding_id,
      context.self.readProductRunForThreadBinding(row.thread_binding_id),
    )
  }
  const source = isFork && row.history_source_thread_binding_id
    ? requireThread(context, row.history_source_thread_binding_id)
    : null
  const forkSeed = isFork ? context.self.readNativeForkMaterialization(row.thread_binding_id) : null
  const effective = isRecord(input.nativeResult) ? input.nativeResult : null
  const recovery = input.forkRecoveryEvidence
  if (recovery && (!isFork || !input.responsePending)) {
    throw new CodexBindingRepositoryError('fork_recovery_evidence_unexpected')
  }
  const resumeEvidence = recovery ? (() => {
    for (const value of [
      recovery.connectionEpoch,
      recovery.preResumeThreadReadDigest,
      recovery.resumedThreadDigest,
    ]) nonEmpty(value, 'fork_recovery_evidence_invalid')
    const lease = context.db.prepare(`
        SELECT 1 AS present FROM codex_sidecar_process_leases
         WHERE connection_epoch = ? AND connection_opened_at IS NOT NULL
           AND closed_at IS NULL AND tree_zero_at IS NULL
         LIMIT 1
      `).get<{ present: number }>(recovery.connectionEpoch)
    if (lease?.present !== 1) {
      throw new CodexBindingRepositoryError('fork_recovery_connection_not_live')
    }
    const value = {
      contract: 'codex_thread_read_before_resume_v1' as const,
      threadBindingId: row.thread_binding_id,
      codexThreadId: thread?.id,
      connectionEpoch: recovery.connectionEpoch,
      preResumeThreadReadDigest: recovery.preResumeThreadReadDigest,
      resumedThreadDigest: recovery.resumedThreadDigest,
    }
    const evidenceDigest = digest(value)
    return {
      ...value,
      resumeEvidenceId: `resume-${evidenceDigest}`,
      evidenceDigest,
    }
  })() : null
  const forkPrefixExact = !isFork || (
    source?.codex_thread_id
    && thread?.id !== source.codex_thread_id
    && thread?.parentThreadId === null
    && thread.forkedFromId === source.codex_thread_id
    && forkSeed
    && digestCanonicalJson(thread.turns.map((turn) => turn.id))
      === digestCanonicalJson(forkSeed.expectedPrefixTurnIds)
    && thread.turns.every((turn) => turn.status !== 'inProgress')
    && thread.turns.at(-1)?.id === row.fork_accepted_through_codex_turn_id
  )
  if (
    !thread
    || thread.id !== input.nativeId
    || !thread.sessionId
    || thread.sessionId !== thread.id
    || (!isFork && thread.parentThreadId !== null)
    || (!isFork && thread.forkedFromId !== null)
    || !forkPrefixExact
    || !row.isolated_thread_cwd
    || !thread.cwd || !sameCodexThreadDirectory(thread.cwd, row.isolated_thread_cwd)
    || thread.source !== 'vscode'
    || thread.threadSource !== null
    || thread.modelProvider !== 'ready_gateway'
    || !Array.isArray(instructionSources)
    || instructionSources.length !== 0
    || (isFork && (
      typeof effective?.cwd !== 'string'
      || !sameCodexThreadDirectory(effective.cwd, row.isolated_thread_cwd)
      || effective.model !== row.codex_model
      || effective.modelProvider !== row.codex_model_provider_id
      || effective.approvalPolicy !== 'never'
      || effective.approvalsReviewer !== 'user'
      || !isPinnedReadOnlySandbox(effective.sandbox)
      || effective.reasoningEffort !== null
      || effective.serviceTier !== null
    ))
  ) throw new CodexBindingRepositoryError('thread_reconciliation_metadata_mismatch')
  if (row.thread_start_reconciled_at) {
    if (row.codex_thread_id !== thread.id) {
      throw new CodexBindingRepositoryError('thread_reconciliation_identity_conflict')
    }
    if (resumeEvidence) {
      const persisted = context.db.prepare(`
          SELECT resume_evidence_id, evidence_digest
            FROM codex_thread_resume_evidence
           WHERE thread_binding_id = ? AND connection_epoch = ?
           LIMIT 1
        `).get<{ resume_evidence_id: string; evidence_digest: string }>(
        row.thread_binding_id,
        resumeEvidence.connectionEpoch,
      )
      if (persisted?.resume_evidence_id !== resumeEvidence.resumeEvidenceId
        || persisted.evidence_digest !== resumeEvidence.evidenceDigest) {
        throw new CodexBindingRepositoryError('fork_recovery_evidence_conflict')
      }
    }
    return
  }
  const evidenceDigest = digest({
    responseDigest: input.responseDigest,
    thread,
    instructionSources,
  })
  const materializationReceipt = isFork ? {
    contract: 'codex_native_fork_materialization_v1',
    targetThreadBindingId: row.thread_binding_id,
    sourceThreadBindingId: row.history_source_thread_binding_id,
    acceptedThroughCodexTurnId: row.fork_accepted_through_codex_turn_id,
    expectedPrefixTurnIdsDigest: row.fork_expected_prefix_turn_ids_digest,
    nativeInheritedContractDigest: row.native_inherited_contract_digest,
    materializationRequestDigest: row.materialization_request_digest,
    dispatchedRequestDigest: row.thread_start_request_digest,
    codexThreadId: thread.id,
    codexSessionId: thread.sessionId,
    cwd: effective?.cwd,
    model: effective?.model,
    modelProvider: effective?.modelProvider,
    approvalPolicy: effective?.approvalPolicy,
    approvalsReviewer: effective?.approvalsReviewer,
    sandbox: effective?.sandbox,
    reasoningEffort: effective?.reasoningEffort,
    serviceTier: effective?.serviceTier,
    instructionSources,
    resumeEvidenceRef: resumeEvidence ? {
      resumeEvidenceId: resumeEvidence.resumeEvidenceId,
      evidenceDigest: resumeEvidence.evidenceDigest,
    } : null,
    responseDigest: input.responseDigest,
    reconciledAt: input.reconciledAt,
  } : null
  const materializationReceiptDigest = materializationReceipt
    ? digestCanonicalJson(materializationReceipt)
    : null
  const update = context.db.prepare(`
      UPDATE codex_thread_bindings
         SET codex_thread_id = ?, codex_session_id = ?, codex_parent_thread_id = ?,
             codex_forked_from_id = ?, codex_source_json = ?, codex_thread_source_json = ?,
             thread_start_response_at = ?, thread_start_reconciled_at = ?,
             thread_start_reconciliation_evidence_digest = ?,
             thread_start_reservation_released_at = ?,
             thread_start_reservation_release_reason = 'native_identity_reconciled',
             thread_started_at = ?,
             materialization_state = CASE WHEN ? THEN 'confirmed' ELSE materialization_state END,
             materialization_effective_receipt_json = CASE WHEN ? THEN ? ELSE materialization_effective_receipt_json END,
             materialization_effective_receipt_digest = CASE WHEN ? THEN ? ELSE materialization_effective_receipt_digest END,
             materialization_evidence_digest = CASE WHEN ? THEN ? ELSE materialization_evidence_digest END,
             action_projection_sequence = action_projection_sequence + CASE WHEN ? THEN 1 ELSE 0 END,
             revision = revision + 1, updated_at = ?
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
    isFork ? 1 : 0,
    isFork ? 1 : 0,
    materializationReceipt ? JSON.stringify(materializationReceipt) : null,
    isFork ? 1 : 0,
    materializationReceiptDigest,
    isFork ? 1 : 0,
    evidenceDigest,
    isFork ? 1 : 0,
    input.reconciledAt,
    row.thread_binding_id,
    row.revision,
  )
  if (changes(update) !== 1) throw new CodexBindingRepositoryError('thread_reconciliation_cas_failed')
  if (resumeEvidence) {
    context.db.prepare(`
        INSERT INTO codex_thread_resume_evidence (
          resume_evidence_id, thread_binding_id, codex_thread_id, connection_epoch,
          pre_resume_thread_read_digest, resumed_thread_digest, evidence_digest, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
      resumeEvidence.resumeEvidenceId,
      resumeEvidence.threadBindingId,
      resumeEvidence.codexThreadId,
      resumeEvidence.connectionEpoch,
      resumeEvidence.preResumeThreadReadDigest,
      resumeEvidence.resumedThreadDigest,
      resumeEvidence.evidenceDigest,
      input.reconciledAt,
    )
  }
  context.db.prepare(`
      UPDATE codex_turn_bindings
         SET codex_thread_id = ?, revision = revision + 1, updated_at = ?
       WHERE thread_binding_id = ? AND codex_thread_id IS NULL
    `).run(thread.id, input.reconciledAt, row.thread_binding_id)
  const readback = requireThread(context, row.thread_binding_id)
  if (
    readback.codex_thread_id !== thread.id
    || readback.thread_start_reservation_released_at !== input.reconciledAt
  ) throw new CodexBindingRepositoryError('thread_reconciliation_readback_mismatch')
  if (isFork) recordSettledForkSourceArchiveIntentInOpenTransaction(context, { targetThreadBindingId: row.thread_binding_id })
}

export function reconcileTurnAccepted(context: CodexBindingContext, input: {
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
  const row = requireTurn(context, input.bindingId)
  const thread = requireThread(context, row.thread_binding_id)
  assertStartRpc(context, row, startDescriptor(context, 'turn/start'), input)
  assertStartFenceNotQuarantined(context, row.thread_binding_id, row.ready_run_id)
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
  const update = context.db.prepare(`
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

export function startDescriptor(context: CodexBindingContext, method: StartMethod) {
  return method !== 'turn/start'
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

export function requireStartRow(context: CodexBindingContext, method: StartMethod, bindingId: string): Record<string, unknown> & {
  revision: number
} {
  const descriptor = startDescriptor(context, method)
  const row = context.db.prepare(`
      SELECT * FROM ${descriptor.table} WHERE ${descriptor.key} = ?
    `).get<Record<string, unknown> & { revision: number }>(bindingId)
  if (!row) throw new CodexBindingRepositoryError('start_binding_not_found')
  return row
}

export function assertStartRpc(
  context: CodexBindingContext,
  row: Record<string, unknown>,
  descriptor: ReturnType<typeof startDescriptor>,
  input: { connectionEpoch: string; rpcId: number },
): void {
  if (
    row[descriptor.epoch] !== input.connectionEpoch
    || row[descriptor.rpcId] !== input.rpcId
    || row[descriptor.intent] === null
  ) throw new CodexBindingRepositoryError('start_rpc_identity_mismatch')
}
