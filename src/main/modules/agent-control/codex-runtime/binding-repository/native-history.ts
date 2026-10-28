import { CodexBindingRepositoryError } from '../codex-binding-error'
import { assertNewCoverageItems, formalModelInputOrigins, resolveAcceptedNativePrefixHead, resolveFormalNativeInputCoverage, type AcceptedNativePrefixResolution } from '../codex-history-continuity-policy'
import { canonicalJson, digestCanonicalJson } from '../codex-model-gateway-contract'
import { readAcceptedNativePrefixHead as readAcceptedNativePrefixHeadFromDb, readNativeCoverage } from '../codex-native-coverage-reader'
import type { CodexTerminalNativeReadbackReceipt } from '../codex-terminal-facts'
import type { CodexBindingContext } from './context'
import { effectiveInstructionContractDigest, readNativeInheritedContractDigest, recordThreadArchiveIntentInOpenTransaction, requireThread, requireTurn } from './core'
import { changes, digest, isPinnedReadOnlySandbox, isRecord, nonEmpty, safePositive } from './shared'
import type { CodexAcceptedNativePrefixHead, CodexNativeCoverageItem, CodexNativeCoverageReceiptRef, ThreadBindingRow } from './types'
import { readUncommittedOriginTails } from './uncommitted-tails'
import { codexThreadPredatesMaterializationRecords } from '../codex-thread-materialization'

// Accepted native history: coverage receipts, accepted prefixes, forks and resume evidence.

export function appendAcceptedNativeCoverageReceipt(context: CodexBindingContext, input: {
  threadBindingId: string
  producerKind: 'product_closeout' | 'automatic_compaction' | 'manual_compaction'
  producerOwnerId: string
  codexThreadId: string
  acceptedNativeHeadKind: 'turn' | 'compaction'
  acceptedNativeHeadId: string
  acceptedProductReadyRunId: string | null
  newlyCovered: CodexNativeCoverageItem[]
  createdAt: string
}): CodexNativeCoverageReceiptRef {
  return context.immediate(() => appendAcceptedNativeCoverageReceiptInOpenTransaction(context, input))
}

export function readAcceptedNativePrefixHead(context: CodexBindingContext, threadBindingId: string): CodexAcceptedNativePrefixHead | null {
  nonEmpty(threadBindingId, 'coverage_thread_binding_invalid')
  const thread = requireThread(context, threadBindingId)
  return readAcceptedNativePrefixHeadFromDb(context.db, thread)
}

export function appendAcceptedNativeCoverageReceiptInOpenTransaction(context: CodexBindingContext, input: {
  threadBindingId: string
  producerKind: 'product_closeout' | 'automatic_compaction' | 'manual_compaction'
  producerOwnerId: string
  codexThreadId: string
  acceptedNativeHeadKind: 'turn' | 'compaction'
  acceptedNativeHeadId: string
  acceptedProductReadyRunId: string | null
  newlyCovered: CodexNativeCoverageItem[]
  createdAt: string
}): CodexNativeCoverageReceiptRef {
  if (context.db.inTransaction !== true) {
    throw new CodexBindingRepositoryError('coverage_transaction_missing')
  }
  for (const value of [
    input.threadBindingId,
    input.producerOwnerId,
    input.codexThreadId,
    input.acceptedNativeHeadId,
    input.createdAt,
  ]) nonEmpty(value, 'coverage_identity_invalid')
  const thread = requireThread(context, input.threadBindingId)
  if (codexThreadPredatesMaterializationRecords(thread.thread_materialization_kind)
    || thread.codex_thread_id !== input.codexThreadId
    || thread.retired_at) {
    throw new CodexBindingRepositoryError('coverage_thread_not_authoritative')
  }
  const latest = context.db.prepare(`
      SELECT receipt_id, receipt_digest
        FROM codex_native_coverage_receipts
       WHERE thread_binding_id = ? ORDER BY rowid DESC LIMIT 1
    `).get<{ receipt_id: string; receipt_digest: string }>(input.threadBindingId)
  let parentReceiptId = latest?.receipt_id ?? null
  if (!parentReceiptId && thread.thread_materialization_kind === 'native_fork') {
    if (!thread.source_accepted_native_coverage_receipt_id
      || !thread.source_accepted_native_coverage_receipt_digest) {
      throw new CodexBindingRepositoryError('coverage_fork_parent_missing')
    }
    const sourceParent = context.db.prepare(`
        SELECT receipt_id, receipt_digest, thread_binding_id
          FROM codex_native_coverage_receipts WHERE receipt_id = ? LIMIT 1
      `).get<{ receipt_id: string; receipt_digest: string; thread_binding_id: string }>(
      thread.source_accepted_native_coverage_receipt_id,
    )
    if (!sourceParent
      || sourceParent.receipt_digest !== thread.source_accepted_native_coverage_receipt_digest
      || context.self.readAcceptedNativePrefixHead(thread.history_source_thread_binding_id!)
        ?.coverageReceiptRef.receiptId !== sourceParent.receipt_id) {
      throw new CodexBindingRepositoryError('coverage_fork_parent_mismatch')
    }
    parentReceiptId = sourceParent.receipt_id
  }
  const coveredItems = parentReceiptId
    ? readNativeCoverage(context.db, parentReceiptId).covered
    : new Map<string, string>()
  try { assertNewCoverageItems(new Set(coveredItems.keys()), input.newlyCovered) }
  catch (error) {
    throw new CodexBindingRepositoryError(error instanceof Error ? error.message : 'coverage_item_invalid')
  }
  if (input.producerKind === 'manual_compaction') {
    const owner = context.db.prepare(`
        SELECT thread_binding_id, codex_thread_id, consumed_at
          FROM codex_manual_compaction_bindings WHERE manual_compaction_id = ? LIMIT 1
      `).get<{ thread_binding_id: string; codex_thread_id: string; consumed_at: string | null }>(
      input.producerOwnerId,
    )
    if (!owner || owner.thread_binding_id !== input.threadBindingId
      || owner.codex_thread_id !== input.codexThreadId || !owner.consumed_at
      || input.acceptedNativeHeadKind !== 'compaction') {
      throw new CodexBindingRepositoryError('coverage_manual_owner_mismatch')
    }
  } else {
    const owner = context.db.prepare(`
        SELECT thread_binding_id, codex_thread_id, codex_turn_id,
               product_terminal_digest, terminal_facts_json, terminal_native_readback_receipt_json
          FROM codex_turn_bindings WHERE ready_run_id = ? LIMIT 1
      `).get<{
      thread_binding_id: string
      codex_thread_id: string | null
      codex_turn_id: string | null
      product_terminal_digest: string | null
      terminal_facts_json: string | null
      terminal_native_readback_receipt_json: string | null
    }>(input.producerOwnerId)
    const automatic = owner?.terminal_native_readback_receipt_json
      ? (JSON.parse(owner.terminal_native_readback_receipt_json) as CodexTerminalNativeReadbackReceipt)
        .contextCompactionItemIds.length > 0
      : false
    if (!owner || owner.thread_binding_id !== input.threadBindingId
      || owner.codex_thread_id !== input.codexThreadId
      || owner.codex_turn_id !== input.acceptedNativeHeadId
      || !owner.product_terminal_digest
      || !owner.terminal_facts_json
      || JSON.parse(owner.terminal_facts_json).product?.terminal !== 'done'
      || input.acceptedProductReadyRunId !== input.producerOwnerId
      || input.producerKind !== (automatic ? 'automatic_compaction' : 'product_closeout')
      || input.acceptedNativeHeadKind !== (automatic ? 'compaction' : 'turn')) {
      throw new CodexBindingRepositoryError('coverage_product_owner_mismatch')
    }
  }
  const newlyCoveredJson = canonicalJson(input.newlyCovered)
  const newlyCoveredDigest = digestCanonicalJson(input.newlyCovered)
  const unsigned = {
    contract: 'codex_native_coverage_receipt_v1',
    threadBindingId: input.threadBindingId,
    parentReceiptId,
    producerKind: input.producerKind,
    producerOwnerId: input.producerOwnerId,
    codexThreadId: input.codexThreadId,
    acceptedNativeHeadKind: input.acceptedNativeHeadKind,
    acceptedNativeHeadId: input.acceptedNativeHeadId,
    acceptedProductReadyRunId: input.acceptedProductReadyRunId,
    newlyCoveredDigest,
    createdAt: input.createdAt,
  }
  const receiptDigest = digestCanonicalJson(unsigned)
  const receiptId = `coverage-${receiptDigest.slice(0, 32)}`
  const existing = context.db.prepare(`
      SELECT receipt_digest FROM codex_native_coverage_receipts
       WHERE producer_owner_id = ? AND producer_kind = ? LIMIT 1
    `).get<{ receipt_digest: string }>(input.producerOwnerId, input.producerKind)
  if (existing) {
    if (existing.receipt_digest !== receiptDigest) {
      throw new CodexBindingRepositoryError('coverage_owner_immutable')
    }
    return { receiptId, digest: receiptDigest }
  }
  context.db.prepare(`
      INSERT INTO codex_native_coverage_receipts (
        receipt_id, thread_binding_id, parent_receipt_id, producer_kind,
        producer_owner_id, codex_thread_id, accepted_native_head_kind,
        accepted_native_head_id, accepted_product_ready_run_id,
        newly_covered_json, newly_covered_digest, receipt_digest, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
    receiptId,
    input.threadBindingId,
    parentReceiptId,
    input.producerKind,
    input.producerOwnerId,
    input.codexThreadId,
    input.acceptedNativeHeadKind,
    input.acceptedNativeHeadId,
    input.acceptedProductReadyRunId,
    newlyCoveredJson,
    newlyCoveredDigest,
    receiptDigest,
    input.createdAt,
  )
  const ownerUpdate = input.producerKind === 'manual_compaction'
    ? context.db.prepare(`
          UPDATE codex_manual_compaction_bindings
             SET accepted_native_coverage_receipt_id = ?,
                 accepted_native_coverage_receipt_digest = ?
           WHERE manual_compaction_id = ?
             AND accepted_native_coverage_receipt_id IS NULL
        `).run(receiptId, receiptDigest, input.producerOwnerId)
    : context.db.prepare(`
          UPDATE codex_turn_bindings
             SET accepted_native_coverage_receipt_id = ?,
                 accepted_native_coverage_receipt_digest = ?
           WHERE ready_run_id = ? AND accepted_native_coverage_receipt_id IS NULL
        `).run(receiptId, receiptDigest, input.producerOwnerId)
  if (changes(ownerUpdate) !== 1) {
    throw new CodexBindingRepositoryError('coverage_owner_ref_cas_failed')
  }
  return { receiptId, digest: receiptDigest }
}

export function readLatestAcceptedForkBoundary(context: CodexBindingContext, input: {
  threadBindingId: string
  beforeReadyRunId: string
}): {
  readyRunId: string | null
  codexTurnId: string
  terminalFactsDigest: string
  coverageReceiptRef: CodexNativeCoverageReceiptRef
} | null {
  const head = context.self.readAcceptedNativePrefixHead(input.threadBindingId)
  if (!head || head.acceptedProductReadyRunId === input.beforeReadyRunId) return null
  const terminalFactsDigest = (head.acceptedProductReadyRunId
    ? requireTurn(context, head.acceptedProductReadyRunId).terminal_facts_digest : null)
    || digestCanonicalJson({
      contract: 'codex_compaction_only_accepted_head_v1',
      coverageReceiptId: head.coverageReceiptRef.receiptId,
      coverageReceiptDigest: head.coverageReceiptRef.digest,
    })
  return {
    readyRunId: head.acceptedProductReadyRunId,
    codexTurnId: head.acceptedNativeHeadId,
    terminalFactsDigest,
    coverageReceiptRef: head.coverageReceiptRef,
  }
}

export function readAcceptedNativePrefixResolution(context: CodexBindingContext, input: {
  readyRunId: string
  nativeReadback: CodexTerminalNativeReadbackReceipt
}): AcceptedNativePrefixResolution {
  const turn = requireTurn(context, input.readyRunId)
  const thread = requireThread(context, turn.thread_binding_id)
  const products = context.db.prepare(`
      SELECT ready_run_id FROM codex_turn_bindings WHERE thread_binding_id = ? ORDER BY rowid ASC
    `).all<{ ready_run_id: string }>(thread.thread_binding_id)
  const compactions = context.db.prepare(`
      SELECT COUNT(*) AS count FROM codex_manual_compaction_bindings WHERE thread_binding_id = ?
    `).get<{ count: number }>(thread.thread_binding_id)
  const readback = input.nativeReadback
  const { digest, ...unsigned } = readback
  const identityMatches = digest === digestCanonicalJson(unsigned)
    && readback.readyRunId === turn.ready_run_id && readback.codexThreadId === turn.codex_thread_id
    && readback.codexTurnId === turn.codex_turn_id
    && readback.aliasGeneration === thread.alias_generation
  return resolveAcceptedNativePrefixHead({
    predatesMaterializationRecords: codexThreadPredatesMaterializationRecords(thread.thread_materialization_kind),
    acceptedHead: context.self.readAcceptedNativePrefixHead(thread.thread_binding_id),
    currentRunId: turn.ready_run_id,
    currentNativeTurnId: turn.codex_turn_id,
    productRunIds: products.map((product) => product.ready_run_id),
    manualCompactionCount: compactions!.count,
    orderedNativeTurnIds: identityMatches ? readback.orderedTurnIds : null,
    nativeCompactionItemCount: readback.contextCompactionItemIds.length,
    uncommittedOriginCount: readUncommittedOriginTails(context, thread.thread_binding_id, turn.ready_run_id).handoffTail.length,
  })
}

export function readNativeForkMaterialization(context: CodexBindingContext, threadBindingId: string): null | {
  targetThreadBindingId: string
  aliasId: string
  sourceThreadBindingId: string
  sourceCodexThreadId: string
  acceptedThroughCodexTurnId: string
  targetCwd: string
  model: string
  materializationState: ThreadBindingRow['materialization_state']
  materializationEvidenceDigest: string | null
  expectedPrefixTurnIds: string[]
  materializationRequestDigest: string
  instructionContractDigest: string
} {
  const target = requireThread(context, threadBindingId)
  if (target.thread_materialization_kind !== 'native_fork') return null
  const source = target.history_source_thread_binding_id
    ? requireThread(context, target.history_source_thread_binding_id)
    : null
  if (!source?.codex_thread_id || !target.fork_accepted_through_codex_turn_id
    || !target.isolated_thread_cwd || !target.codex_model
    || !target.fork_expected_prefix_turn_ids_json
    || !target.fork_expected_prefix_turn_ids_digest
    || !target.materialization_request_digest
    || !target.instruction_contract_digest) {
    throw new CodexBindingRepositoryError('fork_materialization_seed_incomplete')
  }
  const expectedPrefixTurnIds = JSON.parse(target.fork_expected_prefix_turn_ids_json) as unknown
  if (!Array.isArray(expectedPrefixTurnIds)
    || expectedPrefixTurnIds.length < 1
    || expectedPrefixTurnIds.some((turnId) => typeof turnId !== 'string' || !turnId.trim())
    || new Set(expectedPrefixTurnIds).size !== expectedPrefixTurnIds.length
    || expectedPrefixTurnIds.at(-1) !== target.fork_accepted_through_codex_turn_id
    || digestCanonicalJson(expectedPrefixTurnIds) !== target.fork_expected_prefix_turn_ids_digest) {
    throw new CodexBindingRepositoryError('fork_expected_prefix_invalid')
  }
  const expectedInheritedContractDigest = readNativeInheritedContractDigest(context, source)
  const expectedMaterializationRequestDigest = digestCanonicalJson({
    contract: 'codex_native_fork_materialization_request_v1',
    sourceCodexThreadId: source.codex_thread_id,
    acceptedThroughCodexTurnId: target.fork_accepted_through_codex_turn_id,
    expectedPrefixTurnIdsDigest: target.fork_expected_prefix_turn_ids_digest,
    targetCwd: target.isolated_thread_cwd,
    model: target.codex_model,
    modelProvider: 'ready_gateway',
    approvalPolicy: 'never',
    sandbox: 'read-only',
  })
  if (target.native_inherited_contract_digest !== expectedInheritedContractDigest
    || target.materialization_request_digest !== expectedMaterializationRequestDigest
    || target.runtime_manifest_digest !== source.runtime_manifest_digest
    || target.protocol_schema_digest !== source.protocol_schema_digest
    || target.tool_surface_digest !== source.tool_surface_digest
    || target.tool_surface_snapshot_digest !== source.tool_surface_snapshot_digest
    || target.instruction_contract_digest !== source.instruction_contract_digest
    || target.codex_model_provider_id !== source.codex_model_provider_id
    || target.codex_model !== source.codex_model) {
    throw new CodexBindingRepositoryError('fork_inherited_contract_mismatch')
  }
  if (target.materialization_state === 'confirmed') {
    let receipt: Record<string, unknown>
    try {
      receipt = JSON.parse(target.materialization_effective_receipt_json || '') as Record<string, unknown>
    } catch {
      throw new CodexBindingRepositoryError('fork_materialization_receipt_invalid')
    }
    if (!isRecord(receipt)
      || !target.materialization_effective_receipt_digest
      || digestCanonicalJson(receipt) !== target.materialization_effective_receipt_digest
      || receipt.contract !== 'codex_native_fork_materialization_v1'
      || receipt.targetThreadBindingId !== target.thread_binding_id
      || receipt.sourceThreadBindingId !== source.thread_binding_id
      || receipt.acceptedThroughCodexTurnId !== target.fork_accepted_through_codex_turn_id
      || receipt.expectedPrefixTurnIdsDigest !== target.fork_expected_prefix_turn_ids_digest
      || receipt.nativeInheritedContractDigest !== target.native_inherited_contract_digest
      || receipt.materializationRequestDigest !== target.materialization_request_digest
      || receipt.dispatchedRequestDigest !== target.thread_start_request_digest
      || receipt.codexThreadId !== target.codex_thread_id
      || receipt.codexSessionId !== target.codex_session_id
      || receipt.cwd !== target.isolated_thread_cwd
      || receipt.model !== target.codex_model
      || receipt.modelProvider !== target.codex_model_provider_id
      || receipt.approvalPolicy !== 'never'
      || receipt.approvalsReviewer !== 'user'
      || !isPinnedReadOnlySandbox(receipt.sandbox)
      || receipt.reasoningEffort !== null
      || receipt.serviceTier !== null
      || !Array.isArray(receipt.instructionSources)
      || receipt.instructionSources.length !== 0
      || typeof receipt.responseDigest !== 'string'
      || typeof receipt.reconciledAt !== 'string') {
      throw new CodexBindingRepositoryError('fork_materialization_receipt_invalid')
    }
    const resumeRef = receipt.resumeEvidenceRef
    if (target.thread_start_response_at === null) {
      if (!isRecord(resumeRef)
        || typeof resumeRef.resumeEvidenceId !== 'string'
        || typeof resumeRef.evidenceDigest !== 'string') {
        throw new CodexBindingRepositoryError('fork_materialization_resume_ref_missing')
      }
      const resume = context.db.prepare(`
          SELECT resume_evidence_id, evidence_digest, codex_thread_id
            FROM codex_thread_resume_evidence
           WHERE thread_binding_id = ? AND resume_evidence_id = ?
           LIMIT 1
        `).get<{
        resume_evidence_id: string
        evidence_digest: string
        codex_thread_id: string
      }>(target.thread_binding_id, resumeRef.resumeEvidenceId)
      if (resume?.evidence_digest !== resumeRef.evidenceDigest
        || resume.codex_thread_id !== target.codex_thread_id) {
        throw new CodexBindingRepositoryError('fork_materialization_resume_ref_invalid')
      }
    } else if (resumeRef !== null) {
      throw new CodexBindingRepositoryError('fork_materialization_resume_ref_unexpected')
    }
  } else if (target.materialization_effective_receipt_json !== null
    || target.materialization_effective_receipt_digest !== null) {
    throw new CodexBindingRepositoryError('fork_materialization_receipt_premature')
  }
  context.self.readUncommittedUserTail(target.thread_binding_id)
  return {
    targetThreadBindingId: target.thread_binding_id,
    aliasId: target.ready_conversation_alias,
    sourceThreadBindingId: source.thread_binding_id,
    sourceCodexThreadId: source.codex_thread_id,
    acceptedThroughCodexTurnId: target.fork_accepted_through_codex_turn_id,
    targetCwd: target.isolated_thread_cwd,
    model: target.codex_model,
    materializationState: target.materialization_state,
    materializationEvidenceDigest: target.materialization_evidence_digest,
    expectedPrefixTurnIds,
    materializationRequestDigest: target.materialization_request_digest,
    instructionContractDigest: effectiveInstructionContractDigest(
      context,
      target.instruction_contract_digest,
      target.runtime_manifest_digest,
    ),
  }
}

export function recordSettledForkSourceArchiveIntentInOpenTransaction(context: CodexBindingContext, input: {
  targetThreadBindingId: string
}): string {
  if (context.db.inTransaction !== true) {
    throw new CodexBindingRepositoryError('fork_archive_transaction_missing')
  }
    if (!context.self.readNativeForkMaterialization(input.targetThreadBindingId)) {
      throw new CodexBindingRepositoryError('fork_materialization_seed_missing')
    }
    const target = requireThread(context, input.targetThreadBindingId)
    if (target.thread_materialization_kind !== 'native_fork'
      || target.materialization_state !== 'confirmed'
      || !target.history_source_thread_binding_id
      || !target.materialization_effective_receipt_digest) {
      throw new CodexBindingRepositoryError('fork_materialization_not_confirmed')
    }
    const source = requireThread(context, target.history_source_thread_binding_id)
    if (!source.codex_thread_id || source.retired_reason !== 'publication_diverged'
      || !source.retired_at || !source.retirement_evidence_digest) {
      throw new CodexBindingRepositoryError('fork_archive_source_invalid')
    }
    const sourceTurn = context.db.prepare(`
        SELECT ready_run_id, product_terminal_digest
          FROM codex_turn_bindings
         WHERE thread_binding_id = ? AND terminal_facts_digest = ?
           AND product_terminal_digest IS NOT NULL
         LIMIT 1
      `).get<{ ready_run_id: string; product_terminal_digest: string }>(
      source.thread_binding_id,
      target.history_source_terminal_facts_digest,
    )
    if (!sourceTurn) throw new CodexBindingRepositoryError('fork_archive_source_turn_missing')
    context.self.assertThreadArchiveEligible(source.codex_thread_id)
    const retirementTransactionDigest = digestCanonicalJson({
      contract: 'codex_native_fork_source_retirement_v1',
      sourceThreadBindingId: source.thread_binding_id,
      targetThreadBindingId: target.thread_binding_id,
      materializationReceiptDigest: target.materialization_effective_receipt_digest,
      productTerminalDigest: sourceTurn.product_terminal_digest,
    })
    const intentDigest = recordThreadArchiveIntentInOpenTransaction(context, {
      thread: source,
      sourceKind: 'publication_divergence',
      retiredReason: 'publication_diverged',
      readyRunId: sourceTurn.ready_run_id,
      retirementEvidenceDigest: source.retirement_evidence_digest,
      retirementTransactionDigest,
      retiredAt: source.retired_at,
    })
    if (!intentDigest) throw new CodexBindingRepositoryError('fork_archive_intent_missing')
    return intentDigest
}

export function markForkMaterializationProvenAbsent(context: CodexBindingContext, input: {
  threadBindingId: string
  evidenceDigest: string
  recordedAt: string
}): void {
  nonEmpty(input.threadBindingId, 'fork_binding_identity_invalid')
  nonEmpty(input.evidenceDigest, 'fork_evidence_digest_invalid')
  nonEmpty(input.recordedAt, 'fork_evidence_time_invalid')
  context.immediate(() => {
    const row = requireThread(context, input.threadBindingId)
    if (row.thread_materialization_kind !== 'native_fork'
      || row.materialization_state !== 'pending') {
      throw new CodexBindingRepositoryError('fork_materialization_not_pending')
    }
    const updated = context.db.prepare(`
        UPDATE codex_thread_bindings
           SET materialization_state = 'proven_absent', materialization_evidence_digest = ?,
               thread_start_reservation_released_at = ?,
               thread_start_reservation_release_reason = 'fork_materialization_proven_absent',
               action_projection_sequence = action_projection_sequence + 1,
               revision = revision + 1, updated_at = ?
         WHERE thread_binding_id = ? AND revision = ? AND materialization_state = 'pending'
           AND thread_start_reservation_released_at IS NULL
      `).run(
      input.evidenceDigest,
      input.recordedAt,
      input.recordedAt,
      row.thread_binding_id,
      row.revision,
    )
    if (changes(updated) !== 1) {
      throw new CodexBindingRepositoryError('fork_materialization_absent_cas_failed')
    }
  })
}

export function recordThreadResumeEvidence(context: CodexBindingContext, input: {
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
  return context.immediate(() => {
    const thread = context.db.prepare(`
        SELECT thread_binding_id, codex_thread_id
          FROM codex_thread_bindings
         WHERE ready_conversation_alias = ? AND alias_generation = ?
           AND retired_at IS NULL
         LIMIT 1
      `).get<{
      thread_binding_id: string
      codex_thread_id: string | null
    }>(input.aliasId, input.aliasGeneration)
    const lease = context.db.prepare(`
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
    const existing = context.db.prepare(`
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
    context.db.prepare(`
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
    const readback = context.db.prepare(`
        SELECT evidence_digest FROM codex_thread_resume_evidence
         WHERE resume_evidence_id = ?
      `).get<{ evidence_digest: string }>(resumeEvidenceId)
    if (readback?.evidence_digest !== evidenceDigest) {
      throw new CodexBindingRepositoryError('thread_resume_evidence_readback_failed')
    }
    return { resumeEvidenceId, evidenceDigest }
  })
}

export function readFormalCoverageItems(context: CodexBindingContext, readyRunId: string): CodexNativeCoverageItem[] {
  return formalModelInputOrigins(context.self.readProductTurnRuntime(readyRunId).prepared)
}

export function readFormalCoverageItemsForNativeTurns(
  context: CodexBindingContext,
  threadBindingId: string,
  orderedCodexTurnIds: readonly string[],
): CodexNativeCoverageItem[] {
  const result = context.self.readNativeFormalInputCoverage({ threadBindingId, orderedNativeTurnIds: orderedCodexTurnIds })
  if (result.kind !== 'complete') throw new CodexBindingRepositoryError('native_formal_origin_mapping_unknown')
  return result.items
}

export function readNativeFormalInputCoverage(context: CodexBindingContext, input: {
  threadBindingId: string
  orderedNativeTurnIds: readonly string[]
}): ReturnType<typeof resolveFormalNativeInputCoverage> | { kind: 'legacy_boundary' } {
  const thread = requireThread(context, input.threadBindingId)
  if (codexThreadPredatesMaterializationRecords(thread.thread_materialization_kind)) return { kind: 'legacy_boundary' }
  const fork = context.self.readNativeForkMaterialization(input.threadBindingId)
  const provenPrefixTurnIds = new Set(fork?.expectedPrefixTurnIds || [])
  const manuals = context.db.prepare(`SELECT codex_compaction_turn_id FROM codex_manual_compaction_bindings
      WHERE thread_binding_id = ? AND consumed_at IS NOT NULL AND accepted_native_coverage_receipt_id IS NOT NULL`)
    .all<{ codex_compaction_turn_id: string }>(input.threadBindingId)
  for (const manual of manuals) provenPrefixTurnIds.add(manual.codex_compaction_turn_id)
  const turns = input.orderedNativeTurnIds.map((codexTurnId) => {
    const row = context.db.prepare(`
        SELECT ready_run_id FROM codex_turn_bindings
         WHERE thread_binding_id = ? AND codex_turn_id = ? LIMIT 1
      `).get<{ ready_run_id: string }>(input.threadBindingId, codexTurnId)
    return { nativeTurnId: codexTurnId, origins: row ? readFormalCoverageItems(context, row.ready_run_id) : null }
  })
  return resolveFormalNativeInputCoverage({ turns, provenPrefixTurnIds })
}
