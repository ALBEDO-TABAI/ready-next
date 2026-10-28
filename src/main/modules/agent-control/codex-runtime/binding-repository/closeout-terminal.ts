import { parseObjectStrict, workflowDigest } from '../../../repositories/browser-workflow-codec'
import { CodexBindingRepositoryError } from '../codex-binding-error'
import { advanceCodexConversationMessageVisibilityInOpenTransaction, closeCodexConversationScopeInOpenTransaction } from '../codex-conversation-scope-closure'
import { canonicalJson, digestCanonicalJson } from '../codex-model-gateway-contract'
import { assertProductFenceReleased, completeProductTurnCloseoutInOpenTransaction } from './closeout-product'
import type { CodexBindingContext } from './context'
import { assertRuntimeOperationForThread } from './continuity'
import { insertEmptyAliasGenerationInOpenTransaction, nextThreadBindingId, readNativeInheritedContractDigest, recordThreadArchiveIntentInOpenTransaction, requireThread, requireTurn } from './core'
import { assertNativeTerminalCandidate, browserVerifierAttemptFromRow, changes, codexLifecycleActionRetirementDigest, isRecord, nonEmpty } from './shared'
import type { CodexBrowserVerifierAttemptRow, CodexLifecycleAction, CodexNativeForkSeedInput, CodexTerminalCloseoutEvidence, NativeTerminalCandidate, ThreadBindingRow, TurnBindingRow } from './types'

// Verifier, lifecycle action, publication divergence and history reset closeouts.

export function completeVerifierAcceptedCloseoutInOpenTransaction(context: CodexBindingContext, input: {
  readyRunId: string
  productTerminalDigest: string
  closeoutAt: string
  terminalEvidence: CodexTerminalCloseoutEvidence
}): { handled: boolean; reservationSetId: string | null } {
  nonEmpty(input.readyRunId, 'ready_run_id_invalid')
  nonEmpty(input.productTerminalDigest, 'product_terminal_digest_invalid')
  nonEmpty(input.closeoutAt, 'product_closeout_at_invalid')
  if (context.db.inTransaction !== true) {
    throw new CodexBindingRepositoryError('canonical_closeout_transaction_missing')
  }
  const turn = context.db.prepare(`
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
  const thread = requireThread(context, turn.thread_binding_id)
  const attemptRow = context.db.prepare(`
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
  const terminalMessage = context.db.prepare(`
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
  completeProductTurnCloseoutInOpenTransaction(context, input, turn)
  return { handled: true, reservationSetId: turn.start_reservation_set_id }
}

export function completeVerifierRejectedCloseoutInOpenTransaction(context: CodexBindingContext, input: {
  readyRunId: string
  productTerminalDigest: string
  closeoutAt: string
  terminalEvidence: CodexTerminalCloseoutEvidence
  forkSeed?: CodexNativeForkSeedInput
}): {
  handled: boolean
  reservationSetId: string | null
  forkTargetThreadBindingId: string | null
} {
  nonEmpty(input.readyRunId, 'ready_run_id_invalid')
  nonEmpty(input.productTerminalDigest, 'product_terminal_digest_invalid')
  nonEmpty(input.closeoutAt, 'product_closeout_at_invalid')
  if (context.db.inTransaction !== true) {
    throw new CodexBindingRepositoryError('canonical_closeout_transaction_missing')
  }
  const turn = context.db.prepare(`
      SELECT * FROM codex_turn_bindings WHERE ready_run_id = ? LIMIT 1
    `).get<TurnBindingRow>(input.readyRunId)
  if (!turn) return {
    handled: false,
    reservationSetId: null,
    forkTargetThreadBindingId: null,
  }
  if (turn.host_failure_kind || turn.host_failure_product_terminal_digest
    || turn.recovery_failure_code) {
    throw new CodexBindingRepositoryError('product_closeout_kind_conflict')
  }
  if (turn.lifecycle_action
    || turn.interrupt_requested_at || turn.interrupt_ack_at || turn.interrupt_state_unknown_at) {
    throw new CodexBindingRepositoryError('browser_verifier_rejection_interrupted')
  }
  const thread = requireThread(context, turn.thread_binding_id)
  const attemptRow = context.db.prepare(`
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
  const parent = context.db.prepare(`
      SELECT status, interaction_state, continuation_ref_json, resumable_actions_json
        FROM task_projections WHERE task_id = ? AND run_id = ? LIMIT 1
    `).get<{
    status: string
    interaction_state: string
    continuation_ref_json: string | null
    resumable_actions_json: string
  }>(turn.ready_task_id, input.readyRunId)
  const run = context.db.prepare(`
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
  const terminalMessage = context.db.prepare(`
      SELECT id FROM chat_messages WHERE id = ? LIMIT 1
    `).get<{ id: string }>(`assistant:${turn.ready_task_id}:${input.readyRunId}:terminal`)
  if (!terminalMessage) throw new CodexBindingRepositoryError('browser_verifier_terminal_message_missing')
  const child = context.db.prepare(`
      SELECT status FROM browser_tasks
       WHERE parent_task_id = ? AND kind = 'browser_workflow' LIMIT 1
    `).get<{ status: string }>(turn.ready_task_id)
  if (child && !['completed', 'failed', 'cancelled'].includes(child.status)) {
    throw new CodexBindingRepositoryError('browser_verifier_browser_child_not_terminal')
  }
  if (input.terminalEvidence.terminalFacts.history.kind === 'unknown_reset_required') {
    return { ...context.self.completeHistoryResetRequiredCloseoutInOpenTransaction(input), forkTargetThreadBindingId: null }
  }
  if (input.terminalEvidence.terminalFacts.history.kind !== 'diverged') {
    throw new CodexBindingRepositoryError('browser_verifier_terminal_facts_mismatch')
  }
  return context.self.completePublicationDivergenceCloseoutInOpenTransaction(input)
}

export function completeLifecycleActionCloseoutInOpenTransaction(context: CodexBindingContext, input: {
  action: CodexLifecycleAction
  readyRunId: string
  productTerminalDigest: string
  closeoutAt: string
  terminalEvidence: CodexTerminalCloseoutEvidence
  forkSeed?: CodexNativeForkSeedInput
}): {
  handled: boolean
  reservationSetId: string | null
  forkTargetThreadBindingId?: string | null
} {
  nonEmpty(input.readyRunId, 'ready_run_id_invalid')
  nonEmpty(input.productTerminalDigest, 'product_terminal_digest_invalid')
  nonEmpty(input.closeoutAt, 'product_closeout_at_invalid')
  if (context.db.inTransaction !== true) {
    throw new CodexBindingRepositoryError('canonical_closeout_transaction_missing')
  }
  const turn = context.db.prepare(`
      SELECT * FROM codex_turn_bindings WHERE ready_run_id = ? LIMIT 1
    `).get<TurnBindingRow>(input.readyRunId)
  if (!turn) return { handled: false, reservationSetId: null }
  let thread = requireThread(context, turn.thread_binding_id)
  const lifecycle = context.self.readProductLifecycleAction(input.readyRunId)
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
  const effectSettlement = context.self.readToolPublicationBarrier({
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
  const projection = context.db.prepare(`
      SELECT status, interaction_state, continuation_ref_json, resumable_actions_json
        FROM task_projections WHERE task_id = ? AND run_id = ? LIMIT 1
    `).get<{
    status: string
    interaction_state: string
    continuation_ref_json: string | null
    resumable_actions_json: string
  }>(turn.ready_task_id, turn.ready_run_id)
  const run = context.db.prepare(`
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
  const terminalMessage = context.db.prepare(`
      SELECT id FROM chat_messages WHERE id = ? LIMIT 1
    `).get<{ id: string }>(`assistant:${turn.ready_task_id}:${turn.ready_run_id}:terminal`)
  if (!terminalMessage) throw new CodexBindingRepositoryError('lifecycle_action_terminal_message_missing')
  const child = context.db.prepare(`
      SELECT status FROM browser_tasks
       WHERE parent_task_id = ? AND kind = 'browser_workflow' LIMIT 1
    `).get<{ status: string }>(turn.ready_task_id)
  if (child && child.status !== 'cancelled') {
    throw new CodexBindingRepositoryError('lifecycle_action_browser_child_not_cancelled')
  }
  const verifier = context.db.prepare(`
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
    context.self.readLifecycleActionCloseout(input.readyRunId)
    assertProductFenceReleased(context, turn.thread_binding_id, input.readyRunId)
    return { handled: true, reservationSetId: turn.start_reservation_set_id }
  }
  const historyKind = input.terminalEvidence.terminalFacts.history.kind
  if (input.action === 'stop') {
    if (historyKind === 'continuation_safe') {
      completeProductTurnCloseoutInOpenTransaction(context, input, turn)
      return { handled: true, reservationSetId: turn.start_reservation_set_id }
    }
    if (historyKind === 'diverged') {
      return context.self.completePublicationDivergenceCloseoutInOpenTransaction(input)
    }
    if (historyKind === 'unknown_reset_required') {
      const result = context.self.completeHistoryResetRequiredCloseoutInOpenTransaction(input)
      return { ...result, forkTargetThreadBindingId: null }
    }
    throw new CodexBindingRepositoryError('lifecycle_stop_history_invalid')
  }
  if ((input.action === 'reset' && historyKind !== 'reset')
    || (input.action === 'close' && historyKind !== 'closed')) {
    throw new CodexBindingRepositoryError('lifecycle_action_terminal_facts_mismatch')
  }
  if (thread.retired_at || thread.retirement_evidence_digest) {
    throw new CodexBindingRepositoryError('lifecycle_action_thread_already_retired')
  }
  completeProductTurnCloseoutInOpenTransaction(context, input, turn)
  thread = requireThread(context, turn.thread_binding_id)
  const retiredReason = input.action === 'reset' ? 'user_reset' : 'closed'
  const threadUpdate = context.db.prepare(`
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
    newThreadBindingId = nextThreadBindingId(
        context,
        thread.ready_conversation_alias,
        newGeneration,
        lifecycle.lifecycleActionEvidenceDigest,
      )
    insertEmptyAliasGenerationInOpenTransaction(context, {
      threadBindingId: newThreadBindingId,
      aliasId: thread.ready_conversation_alias,
      aliasGeneration: newGeneration,
      readyScopeId: thread.ready_scope_id,
      runtimeManifestDigest: thread.runtime_manifest_digest,
      protocolSchemaDigest: thread.protocol_schema_digest,
      createdAt: input.closeoutAt,
    })
    advanceCodexConversationMessageVisibilityInOpenTransaction(context.db, {
      scopeId: thread.ready_scope_id,
      resetAt: input.closeoutAt,
    })
  }
  context.self.assertThreadArchiveEligible(turn.codex_thread_id)
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
  recordThreadArchiveIntentInOpenTransaction(context, {
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
    closeCodexConversationScopeInOpenTransaction(context.db, {
      scopeId: thread.ready_scope_id,
      closedAt: input.closeoutAt,
      closeEvidenceDigest: retirementTransactionDigest,
    })
  }
  return { handled: true, reservationSetId: turn.start_reservation_set_id }
}

export function completePublicationDivergenceCloseoutInOpenTransaction(context: CodexBindingContext, input: {
  readyRunId: string
  productTerminalDigest: string
  closeoutAt: string
  terminalEvidence?: CodexTerminalCloseoutEvidence
  forkSeed?: CodexNativeForkSeedInput
}): {
  handled: boolean
  reservationSetId: string | null
  forkTargetThreadBindingId: string | null
} {
  if (context.db.inTransaction !== true) {
    throw new CodexBindingRepositoryError('canonical_closeout_transaction_missing')
  }
  const turn = context.db.prepare(`
      SELECT * FROM codex_turn_bindings WHERE ready_run_id = ?
    `).get<TurnBindingRow>(input.readyRunId)
  if (!turn) return {
    handled: false,
    reservationSetId: null,
    forkTargetThreadBindingId: null,
  }
  if (turn.host_failure_kind || !turn.engine_terminal_recorded_at
    || !turn.engine_terminal_candidate_digest) {
    throw new CodexBindingRepositoryError('publication_divergence_evidence_missing')
  }
  if (!input.terminalEvidence || context.self.readAcceptedNativePrefixResolution({
    readyRunId: input.readyRunId,
    nativeReadback: input.terminalEvidence.nativeReadback,
  }).kind === 'unknown') {
    throw new CodexBindingRepositoryError('publication_divergence_prefix_unknown')
  }
  const thread = requireThread(context, turn.thread_binding_id)
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
    const blocked = context.db.prepare(`
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
  completeProductTurnCloseoutInOpenTransaction(context, input, turn)
  const closedTurn = requireTurn(context, input.readyRunId)
  if (!closedTurn.terminal_facts_digest) {
    throw new CodexBindingRepositoryError('publication_divergence_terminal_facts_missing')
  }
  if (!turn.codex_thread_id) {
    throw new CodexBindingRepositoryError('publication_divergence_thread_identity_missing')
  }
  const tail = context.self.readHandoffUncommittedUserTail(thread.thread_binding_id)
  if (tail.length === 0) throw new CodexBindingRepositoryError('uncommitted_user_tail_input_missing')
  const tailDigest = digestCanonicalJson(tail)
  const existingTarget = context.db.prepare(`
      SELECT * FROM codex_thread_bindings
       WHERE history_source_thread_binding_id = ?
         AND history_source_terminal_facts_digest = ?
       LIMIT 2
    `).all<ThreadBindingRow>(thread.thread_binding_id, closedTurn.terminal_facts_digest)
  if (existingTarget.length > 0) {
    if (existingTarget.length !== 1
      || existingTarget[0].ready_conversation_alias !== thread.ready_conversation_alias
      || existingTarget[0].alias_generation !== thread.alias_generation + 1
      || (existingTarget[0].thread_materialization_kind === 'native_fork' && (
        !input.forkSeed
        || existingTarget[0].isolated_thread_cwd !== input.forkSeed.targetCwd
        || existingTarget[0].thread_start_reservation_set_id !== input.forkSeed.reservationSetId
        || existingTarget[0].thread_start_reservation_member_id !== input.forkSeed.reservationId
        || existingTarget[0].source_accepted_native_coverage_receipt_id
          !== context.self.readAcceptedNativePrefixHead(thread.thread_binding_id)?.coverageReceiptRef.receiptId
        || existingTarget[0].uncommitted_user_tail_digest !== tailDigest))) {
      throw new CodexBindingRepositoryError('fork_seed_immutable')
    }
    return {
      handled: true,
      reservationSetId: turn.start_reservation_set_id,
      forkTargetThreadBindingId: existingTarget[0].thread_binding_id,
    }
  }
  const boundary = context.self.readLatestAcceptedForkBoundary({
    threadBindingId: thread.thread_binding_id,
    beforeReadyRunId: input.readyRunId,
  })
  if (!boundary) {
    const targetRuntimeManifestDigest = context.currentContract?.runtimeManifestDigest
    const targetProtocolSchemaDigest = context.currentContract?.protocolSchemaDigest
    if (!targetRuntimeManifestDigest || !targetProtocolSchemaDigest) {
      throw new CodexBindingRepositoryError('runtime_continuity_catalog_unavailable')
    }
    const historySeedDigest = digestCanonicalJson({
      contract: 'codex_fresh_root_with_tail_seed_v1',
      sourceThreadBindingId: thread.thread_binding_id,
      sourceTerminalFactsDigest: closedTurn.terminal_facts_digest,
      tailDigest,
    })
    const targetGeneration = thread.alias_generation + 1
    const targetThreadBindingId = nextThreadBindingId(
      context,
      thread.ready_conversation_alias,
      targetGeneration,
      historySeedDigest,
    )
    context.db.prepare(`
        INSERT INTO codex_thread_bindings (
          thread_binding_id, ready_conversation_alias, alias_generation, ready_scope_id,
          runtime_manifest_digest, protocol_schema_digest,
          thread_materialization_kind, materialization_state,
          history_source_thread_binding_id, history_source_terminal_facts_digest,
          history_seed_digest, uncommitted_user_tail_json, uncommitted_user_tail_digest,
          action_projection_sequence, revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'fresh_root_with_tail', 'confirmed',
          ?, ?, ?, ?, ?, 1, 1, ?, ?)
      `).run(
      targetThreadBindingId,
      thread.ready_conversation_alias,
      targetGeneration,
      thread.ready_scope_id,
      targetRuntimeManifestDigest,
      targetProtocolSchemaDigest,
      thread.thread_binding_id,
      closedTurn.terminal_facts_digest,
      historySeedDigest,
      canonicalJson(tail),
      tailDigest,
      input.closeoutAt,
      input.closeoutAt,
    )
    const retirementTransactionDigest = digestCanonicalJson({
      contract: 'codex_fresh_root_with_tail_retirement_v1',
      sourceThreadBindingId: thread.thread_binding_id,
      targetThreadBindingId,
      productTerminalDigest: input.productTerminalDigest,
      sourceTerminalFactsDigest: closedTurn.terminal_facts_digest,
    })
    recordThreadArchiveIntentInOpenTransaction(context, {
      thread: requireThread(context, thread.thread_binding_id),
      sourceKind: 'publication_divergence',
      retiredReason: 'publication_diverged',
      readyRunId: input.readyRunId,
      retirementEvidenceDigest: turn.engine_terminal_candidate_digest,
      retirementTransactionDigest,
      retiredAt: input.closeoutAt,
    })
    return {
      handled: true,
      reservationSetId: turn.start_reservation_set_id,
      forkTargetThreadBindingId: targetThreadBindingId,
    }
  }
  assertRuntimeOperationForThread(
    context,
    thread.thread_binding_id,
    'fork_from_accepted_prefix',
  )
  if (!input.forkSeed) throw new CodexBindingRepositoryError('fork_seed_missing')
  for (const value of [
    input.forkSeed.targetCwd,
    input.forkSeed.reservationSetId,
    input.forkSeed.reservationId,
    input.forkSeed.reservationEvidenceDigest,
    thread.isolated_thread_cwd || '',
    thread.tool_surface_digest || '',
    thread.tool_surface_snapshot_digest || '',
    thread.tool_surface_json || '',
    thread.instruction_contract_digest || '',
    thread.codex_model || '',
    thread.upstream_profile_snapshot_ref || '',
    thread.upstream_profile_snapshot_digest || '',
  ]) nonEmpty(value, 'fork_seed_contract_incomplete')
  const orderedTurnIds = input.terminalEvidence?.nativeReadback.orderedTurnIds || []
  const cutoffIndexes = orderedTurnIds.flatMap((turnId, index) => (
    turnId === boundary.codexTurnId ? [index] : []
  ))
  if (cutoffIndexes.length !== 1) {
    throw new CodexBindingRepositoryError('fork_expected_prefix_unavailable')
  }
  const expectedPrefixTurnIds = orderedTurnIds.slice(0, cutoffIndexes[0] + 1)
  const expectedPrefixTurnIdsDigest = digestCanonicalJson(expectedPrefixTurnIds)
  const targetGeneration = thread.alias_generation + 1
  const inheritedContractDigest = readNativeInheritedContractDigest(context, thread)
  const materializationRequestDigest = digestCanonicalJson({
    contract: 'codex_native_fork_materialization_request_v1',
    sourceCodexThreadId: thread.codex_thread_id,
    acceptedThroughCodexTurnId: boundary.codexTurnId,
    expectedPrefixTurnIdsDigest,
    targetCwd: input.forkSeed.targetCwd,
    model: thread.codex_model,
    modelProvider: 'ready_gateway',
    approvalPolicy: 'never',
    sandbox: 'read-only',
  })
  const historySeedDigest = digestCanonicalJson({
    sourceThreadBindingId: thread.thread_binding_id,
    sourceTerminalFactsDigest: closedTurn.terminal_facts_digest,
    acceptedProductBoundaryReadyRunId: boundary.readyRunId,
    acceptedNativeCoverageReceiptRef: boundary.coverageReceiptRef,
    forkAcceptedThroughCodexTurnId: boundary.codexTurnId,
    divergentIngressDigest: closedTurn.ingress_admitted_digest,
    uncommittedUserTailDigest: tailDigest,
  })
  const targetThreadBindingId = nextThreadBindingId(
    context,
    thread.ready_conversation_alias,
    targetGeneration,
    historySeedDigest,
  )
  const forkRequestId = `codex-fork-${digestCanonicalJson({
      targetThreadBindingId,
      sourceThreadId: thread.codex_thread_id,
      acceptedThrough: boundary.codexTurnId,
    }).slice(0, 32)}`
  context.db.prepare(`
      INSERT INTO codex_thread_bindings (
        thread_binding_id,
        thread_start_reservation_set_id, thread_start_reservation_member_id,
        thread_start_reservation_admitted_at, thread_start_request_id,
        isolated_thread_cwd,
        ready_conversation_alias, alias_generation, ready_scope_id,
        runtime_manifest_digest, protocol_schema_digest,
        tool_surface_digest, tool_surface_snapshot_digest, tool_surface_json,
        instruction_contract_digest, codex_model_provider_id, codex_model,
        upstream_profile_snapshot_ref, upstream_profile_snapshot_digest,
        thread_materialization_kind, history_source_thread_binding_id,
        history_source_terminal_facts_digest, fork_accepted_through_codex_turn_id,
        fork_expected_prefix_turn_ids_json, fork_expected_prefix_turn_ids_digest,
        materialization_request_digest,
        accepted_product_boundary_ready_run_id, native_inherited_contract_digest,
        source_accepted_native_coverage_receipt_id,
        source_accepted_native_coverage_receipt_digest,
        materialization_state, history_seed_digest,
        uncommitted_user_tail_json, uncommitted_user_tail_digest,
        action_projection_sequence,
        revision, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        'native_fork', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, 1, 1, ?, ?
      )
    `).run(
    targetThreadBindingId,
    input.forkSeed.reservationSetId,
    input.forkSeed.reservationId,
    input.closeoutAt,
    forkRequestId,
    input.forkSeed.targetCwd,
    thread.ready_conversation_alias,
    targetGeneration,
    thread.ready_scope_id,
    thread.runtime_manifest_digest,
    thread.protocol_schema_digest,
    thread.tool_surface_digest,
    thread.tool_surface_snapshot_digest,
    thread.tool_surface_json,
    thread.instruction_contract_digest,
    thread.codex_model_provider_id,
    thread.codex_model,
    thread.upstream_profile_snapshot_ref,
    thread.upstream_profile_snapshot_digest,
    thread.thread_binding_id,
    closedTurn.terminal_facts_digest,
    boundary.codexTurnId,
    canonicalJson(expectedPrefixTurnIds),
    expectedPrefixTurnIdsDigest,
    materializationRequestDigest,
    boundary.readyRunId,
    inheritedContractDigest,
    boundary.coverageReceiptRef.receiptId,
    boundary.coverageReceiptRef.digest,
    historySeedDigest,
    canonicalJson(tail),
    tailDigest,
    input.closeoutAt,
    input.closeoutAt,
  )
  const target = requireThread(context, targetThreadBindingId)
  if (target.materialization_state !== 'pending'
    || target.history_source_thread_binding_id !== thread.thread_binding_id
    || target.retired_at !== null) {
    throw new CodexBindingRepositoryError('fork_seed_readback_mismatch')
  }
  return {
    handled: true,
    reservationSetId: turn.start_reservation_set_id,
    forkTargetThreadBindingId: targetThreadBindingId,
  }
}

export function completeHistoryResetRequiredCloseoutInOpenTransaction(context: CodexBindingContext, input: {
  readyRunId: string
  productTerminalDigest: string
  closeoutAt: string
  terminalEvidence: CodexTerminalCloseoutEvidence
}): { handled: boolean; reservationSetId: string | null } {
  if (context.db.inTransaction !== true) {
    throw new CodexBindingRepositoryError('canonical_closeout_transaction_missing')
  }
  const turn = context.db.prepare(`
      SELECT * FROM codex_turn_bindings WHERE ready_run_id = ?
    `).get<TurnBindingRow>(input.readyRunId)
  if (!turn) return { handled: false, reservationSetId: null }
  if (input.terminalEvidence.terminalFacts.product.terminal === 'done'
    && context.self.readBrowserVerifierAttempt(input.readyRunId)) {
    context.self.completeVerifierAcceptedCloseoutInOpenTransaction(input)
  } else {
    completeProductTurnCloseoutInOpenTransaction(context, input, turn)
  }
  const closedTurn = requireTurn(context, input.readyRunId)
  if (!closedTurn.terminal_facts_digest) {
    throw new CodexBindingRepositoryError('history_reset_terminal_facts_missing')
  }
  const updatedThread = requireThread(context, turn.thread_binding_id)
  const blocked = context.db.prepare(`
      UPDATE codex_thread_bindings
         SET continuation_blocked_at = ?,
             continuation_blocked_reason = 'publication_diverged',
             continuation_blocked_evidence_digest = ?,
             revision = revision + 1, updated_at = ?
       WHERE thread_binding_id = ? AND revision = ?
         AND retired_at IS NULL AND continuation_blocked_at IS NULL
    `).run(
    input.closeoutAt,
    closedTurn.terminal_facts_digest,
    input.closeoutAt,
    updatedThread.thread_binding_id,
    updatedThread.revision,
  )
  if (changes(blocked) !== 1) {
    throw new CodexBindingRepositoryError('history_reset_block_cas_failed')
  }
  return { handled: true, reservationSetId: turn.start_reservation_set_id }
}
