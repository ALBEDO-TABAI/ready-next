import { createHash } from 'node:crypto'
import { workflowDigest } from '../../../repositories/browser-workflow-codec'
import { CodexBindingRepositoryError } from '../codex-binding-error'
import { canonicalJson, digestCanonicalJson } from '../codex-model-gateway-contract'
import { excludeAlreadyCoveredItems } from '../codex-native-coverage-reader'
import { assertCodexTerminalEvidenceOwners } from '../codex-terminal-evidence-validation'
import { assertCodexTerminalFacts, type CodexTerminalFacts } from '../codex-terminal-facts'
import type { CodexBindingContext } from './context'
import { requireThread, requireTurn } from './core'
import { appendAcceptedNativeCoverageReceiptInOpenTransaction, readFormalCoverageItemsForNativeTurns } from './native-history'
import { changes, hostFailureContinuationBlockedReason, nonEmpty } from './shared'
import type { CodexTerminalCloseoutEvidence, NativeTerminalCandidate, TurnBindingRow } from './types'
import { codexThreadPredatesMaterializationRecords } from '../codex-thread-materialization'

// Product turn, host failure and recovery failure closeouts.

export function recordHostFailureEvidence(context: CodexBindingContext, input: {
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
  context.immediate(() => {
    const row = requireTurn(context, input.readyRunId)
    if (row.host_failure_kind) {
      if (
        row.host_failure_kind !== input.kind
        || row.host_failure_evidence_digest !== input.evidenceDigest
      ) throw new CodexBindingRepositoryError('host_failure_evidence_immutable')
      return
    }
    const result = context.db.prepare(`
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

export function completeHostFailureCloseout(context: CodexBindingContext, input: {
  readyRunId: string
  productTerminalDigest: string
  continuationBlockedReason: 'start_delivery_absent' | 'publication_diverged'
  closeoutAt: string
}): { reservationSetId: string } {
  nonEmpty(input.productTerminalDigest, 'product_terminal_digest_invalid')
  nonEmpty(input.closeoutAt, 'product_closeout_at_invalid')
  return context.immediate(() => completeHostFailureCloseoutInOpenTransaction(context, input))
}

export function completeProductTurnCloseout(context: CodexBindingContext, input: {
  readyRunId: string
  productTerminalDigest: string
  closeoutAt: string
}): void {
  nonEmpty(input.productTerminalDigest, 'product_terminal_digest_invalid')
  nonEmpty(input.closeoutAt, 'product_closeout_at_invalid')
  context.immediate(() => {
    const turn = requireTurn(context, input.readyRunId)
    const terminal = context.db.prepare(`
        SELECT status FROM task_projections
         WHERE task_id = ? AND run_id = ? AND status IN ('completed', 'failed', 'killed')
         LIMIT 1
      `).get<{ status: string }>(turn.ready_task_id, input.readyRunId)
    if (!terminal) throw new CodexBindingRepositoryError('product_terminal_not_committed')
    completeProductTurnCloseoutInOpenTransaction(context, input, turn)
  })
}

export function completeCanonicalProductCloseoutInOpenTransaction(context: CodexBindingContext, input: {
  readyRunId: string
  productTerminalDigest: string
  closeoutAt: string
  terminalEvidence?: CodexTerminalCloseoutEvidence
}): { handled: boolean; reservationSetId: string | null } {
  nonEmpty(input.readyRunId, 'ready_run_id_invalid')
  nonEmpty(input.productTerminalDigest, 'product_terminal_digest_invalid')
  nonEmpty(input.closeoutAt, 'product_closeout_at_invalid')
  if (context.db.inTransaction !== true) {
    throw new CodexBindingRepositoryError('canonical_closeout_transaction_missing')
  }
  const turn = context.db.prepare(`
      SELECT * FROM codex_turn_bindings WHERE ready_run_id = ?
    `).get<TurnBindingRow>(input.readyRunId)
  if (!turn) return { handled: false, reservationSetId: null }
  if (turn.host_failure_kind) {
    const completed = completeHostFailureCloseoutInOpenTransaction(context, {
      ...input,
      continuationBlockedReason: hostFailureContinuationBlockedReason(turn),
    })
    return { handled: true, reservationSetId: completed.reservationSetId }
  }
  completeProductTurnCloseoutInOpenTransaction(context, input, turn)
  return { handled: true, reservationSetId: turn.start_reservation_set_id }
}

export function completeRecoveryFailureCloseoutInOpenTransaction(context: CodexBindingContext, input: {
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
  if (context.db.inTransaction !== true) {
    throw new CodexBindingRepositoryError('canonical_closeout_transaction_missing')
  }
  const turn = context.db.prepare(`
      SELECT * FROM codex_turn_bindings WHERE ready_run_id = ?
    `).get<TurnBindingRow>(input.readyRunId)
  if (!turn) return { handled: false, reservationSetId: null }
  completeRecoveryFailureCloseout(context, input, turn)
  return { handled: true, reservationSetId: turn.start_reservation_set_id }
}

export function completeProductTurnCloseoutInOpenTransaction(
  context: CodexBindingContext,
  input: {
    readyRunId: string
    productTerminalDigest: string
    closeoutAt: string
    terminalEvidence?: CodexTerminalCloseoutEvidence
  },
  turn = requireTurn(context, input.readyRunId),
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
    if (input.terminalEvidence) {
      const factsDigest = digestCanonicalJson(input.terminalEvidence.terminalFacts)
      if (turn.terminal_native_readback_receipt_digest !== input.terminalEvidence.nativeReadback.digest
        || turn.terminal_facts_digest !== factsDigest) {
        throw new CodexBindingRepositoryError('terminal_facts_immutable')
      }
    }
    assertProductFenceReleased(context, turn.thread_binding_id, input.readyRunId)
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
  const terminalEvidence = input.terminalEvidence || null
  let nativeReadbackJson: string | null = null
  let nativeReadbackDigest: string | null = null
  let nativeReadbackRevision: number | null = null
  let terminalFactsJson: string | null = null
  let terminalFactsDigest: string | null = null
  if (terminalEvidence) {
    const receipt = terminalEvidence.nativeReadback
    const { digest: receiptDigest, ...unsignedReceipt } = receipt
    assertCodexTerminalFacts(terminalEvidence.terminalFacts)
    assertCodexTerminalEvidenceOwners(context.db, context.self, terminalEvidence)
    const thread = requireThread(context, turn.thread_binding_id)
    const scope = context.db.prepare(`
        SELECT message_visibility_epoch FROM chat_conversations WHERE id = ? LIMIT 1
      `).get<{ message_visibility_epoch: number }>(thread.ready_scope_id)
    const run = context.db.prepare(`
        SELECT status, terminal_reason FROM run_meta
         WHERE run_id = ? AND task_id = ? LIMIT 1
      `).get<{ status: string; terminal_reason: string | null }>(
      turn.ready_run_id,
      turn.ready_task_id,
    )
    const expectedProductTerminal = run?.status === 'done' || run?.status === 'completed'
      ? 'done'
      : run?.status === 'error' || run?.status === 'failed'
        ? 'error'
        : run?.status === 'cancelled'
          ? 'cancelled'
          : run?.status === 'interrupted' || run?.status === 'preempted' || run?.status === 'killed'
            ? 'interrupted'
            : null
    const facts = terminalEvidence.terminalFacts
    const allEvidence = [
      ...facts.product.evidence,
      ...facts.history.evidence,
      ...facts.effect.evidence,
    ]
    if (receiptDigest !== digestCanonicalJson(unsignedReceipt)
      || receipt.readyRunId !== turn.ready_run_id
      || receipt.readyScopeId !== thread.ready_scope_id
      || receipt.messageVisibilityEpoch !== scope?.message_visibility_epoch
      || receipt.aliasGeneration !== thread.alias_generation
      || receipt.codexThreadId !== turn.codex_thread_id
      || receipt.codexTurnId !== turn.codex_turn_id
      || receipt.turnStatus !== turn.engine_terminal_status
      || expectedProductTerminal !== facts.product.terminal
      || run?.terminal_reason !== facts.product.terminalReason
      || allEvidence.some((reference) => (
        reference.readyRunId !== turn.ready_run_id
        || reference.readyScopeId !== thread.ready_scope_id
        || reference.messageVisibilityEpoch !== scope?.message_visibility_epoch
        || reference.aliasGeneration !== thread.alias_generation
        || reference.codexThreadId !== turn.codex_thread_id
        || reference.codexTurnId !== turn.codex_turn_id
      ))) {
      throw new CodexBindingRepositoryError('terminal_facts_identity_mismatch')
    }
    nativeReadbackJson = canonicalJson(receipt)
    nativeReadbackDigest = receiptDigest
    nativeReadbackRevision = receipt.turnRevision
    terminalFactsJson = canonicalJson(terminalEvidence.terminalFacts)
    terminalFactsDigest = digestCanonicalJson(terminalEvidence.terminalFacts)
  }
  if (!turn.lifecycle_action) {
    assertEngineTerminalPublicationMatchesReady(
      context,
      turn,
      input.closeoutAt,
      input.productTerminalDigest,
      terminalEvidence?.terminalFacts || null,
    )
  }
  const fence = requireProductFenceForRelease(context, turn.thread_binding_id, input.readyRunId)
  const fenceReleaseRevision = fence.revision + 1
  const turnUpdate = context.db.prepare(`
      UPDATE codex_turn_bindings
         SET product_terminal_digest = ?, product_closeout_at = ?,
             terminal_native_readback_receipt_json = ?,
             terminal_native_readback_receipt_digest = ?,
             terminal_native_readback_revision = ?,
             terminal_facts_json = ?, terminal_facts_digest = ?,
             fence_release_revision = ?,
             revision = revision + 1, updated_at = ?
       WHERE ready_run_id = ? AND revision = ? AND product_terminal_digest IS NULL
    `).run(
    input.productTerminalDigest,
    input.closeoutAt,
    nativeReadbackJson,
    nativeReadbackDigest,
    nativeReadbackRevision,
    terminalFactsJson,
    terminalFactsDigest,
    fenceReleaseRevision,
    input.closeoutAt,
    input.readyRunId,
    turn.revision,
  )
  if (changes(turnUpdate) !== 1) throw new CodexBindingRepositoryError('product_terminal_cas_failed')
  const closedTurn = requireTurn(context, input.readyRunId)
  const closeoutThread = requireThread(context, closedTurn.thread_binding_id)
  if (closedTurn.terminal_facts_json
    && !codexThreadPredatesMaterializationRecords(closeoutThread.thread_materialization_kind)) {
    const facts = JSON.parse(closedTurn.terminal_facts_json) as CodexTerminalFacts
    if (facts.product.terminal === 'done' && facts.history.kind === 'continuation_safe') {
      const automatic = Boolean(input.terminalEvidence?.nativeReadback.contextCompactionItemIds.length)
      const coverageCandidates = readFormalCoverageItemsForNativeTurns(
        context,
        closedTurn.thread_binding_id,
        input.terminalEvidence?.nativeReadback.orderedTurnIds || [closedTurn.codex_turn_id as string],
      )
      const priorHead = context.self.readAcceptedNativePrefixHead(closedTurn.thread_binding_id)
      appendAcceptedNativeCoverageReceiptInOpenTransaction(context, {
        threadBindingId: closedTurn.thread_binding_id,
        producerKind: automatic ? 'automatic_compaction' : 'product_closeout',
        producerOwnerId: closedTurn.ready_run_id,
        codexThreadId: closedTurn.codex_thread_id as string,
        acceptedNativeHeadKind: automatic ? 'compaction' : 'turn',
        acceptedNativeHeadId: closedTurn.codex_turn_id as string,
        acceptedProductReadyRunId: closedTurn.ready_run_id,
        newlyCovered: excludeAlreadyCoveredItems(context.db,
          priorHead?.coverageReceiptRef.receiptId ?? null,
          coverageCandidates,
        ),
        createdAt: input.closeoutAt,
      })
    }
  }
  const headAdvanced = context.db.prepare(`
      UPDATE codex_thread_bindings
         SET action_projection_sequence = action_projection_sequence + 1,
             revision = revision + 1, updated_at = ?
       WHERE thread_binding_id = ?
    `).run(input.closeoutAt, turn.thread_binding_id)
  if (changes(headAdvanced) !== 1) {
    throw new CodexBindingRepositoryError('action_projection_sequence_advance_failed')
  }
  const fenceDelete = context.db.prepare(`
      DELETE FROM codex_thread_dispatch_fences
       WHERE thread_binding_id = ? AND owner_ready_run_id = ? AND revision = ?
    `).run(turn.thread_binding_id, input.readyRunId, fence.revision)
  if (changes(fenceDelete) !== 1) throw new CodexBindingRepositoryError('product_fence_release_failed')
}

export function completeRecoveryFailureCloseout(context: CodexBindingContext, input: {
  readyRunId: string
  productTerminalDigest: string
  closeoutAt: string
  recoveryFailureCode: string
  recoveryFailureEvidenceDigest: string
}, turn: TurnBindingRow): void {
  const thread = requireThread(context, turn.thread_binding_id)
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
      || thread.retired_at !== null
    ) throw new CodexBindingRepositoryError('recovery_failure_closeout_incomplete')
    assertProductFenceReleased(context, turn.thread_binding_id, input.readyRunId)
    return
  }
  if (turn.recovery_failure_code || turn.recovery_failure_evidence_digest
    || turn.recovery_failure_recorded_at) {
    throw new CodexBindingRepositoryError('recovery_failure_evidence_conflict')
  }
  if (thread.continuation_blocked_at || thread.retired_at) {
    throw new CodexBindingRepositoryError('recovery_failure_thread_already_closed')
  }
  const fence = requireProductFenceForRelease(context, turn.thread_binding_id, input.readyRunId)
  const fenceReleaseRevision = fence.revision + 1
  const turnUpdate = context.db.prepare(`
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
  const threadUpdate = context.db.prepare(`
      UPDATE codex_thread_bindings
         SET thread_start_reservation_released_at = COALESCE(thread_start_reservation_released_at, ?),
             thread_start_reservation_release_reason = COALESCE(
               thread_start_reservation_release_reason, 'product_recovery_failure'
             ),
             continuation_blocked_at = ?, continuation_blocked_reason = 'publication_diverged',
             continuation_blocked_evidence_digest = ?,
             action_projection_sequence = action_projection_sequence + 1,
             revision = revision + 1, updated_at = ?
       WHERE thread_binding_id = ? AND revision = ?
         AND continuation_blocked_at IS NULL AND retired_at IS NULL
    `).run(
    input.closeoutAt,
    input.closeoutAt,
    input.recoveryFailureEvidenceDigest,
    input.closeoutAt,
    thread.thread_binding_id,
    thread.revision,
  )
  if (changes(threadUpdate) !== 1) {
    throw new CodexBindingRepositoryError('recovery_failure_thread_cas_failed')
  }
  const fenceDelete = context.db.prepare(`
      DELETE FROM codex_thread_dispatch_fences
       WHERE thread_binding_id = ? AND owner_ready_run_id = ? AND revision = ?
    `).run(turn.thread_binding_id, input.readyRunId, fence.revision)
  if (changes(fenceDelete) !== 1) {
    throw new CodexBindingRepositoryError('product_fence_release_failed')
  }
}

export function completeHostFailureCloseoutInOpenTransaction(context: CodexBindingContext, input: {
  readyRunId: string
  productTerminalDigest: string
  continuationBlockedReason: 'start_delivery_absent' | 'publication_diverged'
  closeoutAt: string
}): { reservationSetId: string } {
  const turn = requireTurn(context, input.readyRunId)
  if (!turn.host_failure_kind || !turn.host_failure_evidence_digest) {
    throw new CodexBindingRepositoryError('host_failure_evidence_missing')
  }
  if (turn.product_terminal_digest) {
    throw new CodexBindingRepositoryError('product_closeout_kind_conflict')
  }
  const thread = requireThread(context, turn.thread_binding_id)
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
    assertProductFenceReleased(context, thread.thread_binding_id, input.readyRunId)
    return { reservationSetId: turn.start_reservation_set_id }
  }
  const productFence = requireProductFenceForRelease(context, thread.thread_binding_id, input.readyRunId)
  const fenceReleaseRevision = productFence.revision + 1
  const turnUpdate = context.db.prepare(`
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
    const threadUpdate = context.db.prepare(`
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
    const threadUpdate = context.db.prepare(`
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
  const fence = context.db.prepare(`
      DELETE FROM codex_thread_dispatch_fences
       WHERE thread_binding_id = ? AND owner_ready_run_id = ? AND revision = ?
    `).run(thread.thread_binding_id, input.readyRunId, productFence.revision)
  if (changes(fence) !== 1) throw new CodexBindingRepositoryError('product_fence_release_failed')
  return { reservationSetId: turn.start_reservation_set_id }
}

export function assertProductFenceReleased(context: CodexBindingContext, threadBindingId: string, readyRunId: string): void {
  const fence = context.db.prepare(`
      SELECT owner_ready_run_id FROM codex_thread_dispatch_fences
       WHERE thread_binding_id = ? AND operation_kind = 'product_turn'
         AND owner_ready_run_id = ? LIMIT 1
    `).get(threadBindingId, readyRunId)
  if (fence) throw new CodexBindingRepositoryError('product_fence_owner_mismatch')
}

export function assertEngineTerminalPublicationMatchesReady(
  context: CodexBindingContext,
  turn: TurnBindingRow,
  closeoutAt: string,
  productTerminalDigest: string,
  terminalFacts: CodexTerminalFacts | null,
): void {
  const receipt = context.self.readEngineTerminalCandidate(turn.ready_run_id)
  if (!receipt) throw new CodexBindingRepositoryError('engine_terminal_receipt_missing')
  const candidate = receipt.candidate as NativeTerminalCandidate
  const thread = requireThread(context, turn.thread_binding_id)
  const publication = context.self.readToolPublicationReceipt(turn.ready_run_id)
  const projection = context.db.prepare(`
      SELECT status FROM task_projections
       WHERE task_id = ? AND run_id = ? LIMIT 1
    `).get<{ status: string }>(turn.ready_task_id, turn.ready_run_id)
  const messageId = `assistant:${turn.ready_task_id}:${turn.ready_run_id}:terminal`
  const message = context.db.prepare(`
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
    // silent-catch: unparseable meta_json yields an empty digest, so the message fails the publication match below
    canonicalDigest = ''
  }
  const canonicalFailureMessageMatches = Boolean(
    message
    && message.conversation_id === thread.ready_scope_id
    && message.role === 'assistant'
    && message.timestamp === closeoutAt
    && canonicalDigest === productTerminalDigest,
  )
  if (terminalFacts
    ? terminalFacts.product.terminal !== 'done'
    : thread.continuation_blocked_reason === 'publication_diverged') {
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

export function requireProductFenceForRelease(
  context: CodexBindingContext,
  threadBindingId: string,
  readyRunId: string,
): { revision: number } {
  const fence = context.db.prepare(`
      SELECT revision FROM codex_thread_dispatch_fences
       WHERE thread_binding_id = ? AND operation_kind = 'product_turn'
         AND owner_ready_run_id = ? AND owner_manual_compaction_id IS NULL
         AND quarantined_at IS NULL
       LIMIT 1
    `).get<{ revision: number }>(threadBindingId, readyRunId)
  if (!fence) throw new CodexBindingRepositoryError('product_fence_owner_mismatch')
  return fence
}
