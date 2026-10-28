import { CodexBindingRepositoryError } from '../codex-binding-error'
import { nativeInheritedContractDigest } from '../codex-history-continuity-policy'
import { digestCanonicalJson, resolveCodexNativeModelSettings, type CodexUpstreamProfileSnapshot } from '../codex-model-gateway-contract'
import { resolveInstructionContractTransition } from '../codex-runtime-compatibility'
import { recordCodexThreadArchiveIntentInOpenTransaction, type CodexThreadArchiveSourceKind, type CodexThreadRetirementReason } from '../codex-thread-archive-cleanup'
import { codexRequestToolsDigest, type ReadyToolSurface } from '../codex-tool-surface'
import type { CodexBindingContext } from './context'
import { digest, isRecord, nonEmpty, processLeaseFromRow, safePositive } from './shared'
import type { CodexAdmittedBindingInput, CodexEmptyAliasGenerationInput, CodexProcessLeaseRow, ProcessLeaseDbRow, ThreadBindingRow, TurnBindingRow } from './types'

// Rows, identities and contract digests every binding-repository operation builds on.

/**
 * The instruction contract a thread's requests carry under the current runtime. The stored digest is the thread's
 * immutable lineage contract. A runtime upgrade can change Codex's native base instructions; when the verified
 * transition from the thread's creating runtime declares that the current runtime serves this lineage with the
 * current contract (new base, same Ready developer instructions), that is the effective contract.
 */
export function effectiveInstructionContractDigest(context: CodexBindingContext, lineageDigest: string, creationManifestDigest: string): string

export function effectiveInstructionContractDigest(
  context: CodexBindingContext,
  lineageDigest: string | null,
  creationManifestDigest: string,
): string | null

export function effectiveInstructionContractDigest(
  context: CodexBindingContext,
  lineageDigest: string | null,
  creationManifestDigest: string,
): string | null {
  const current = context.currentContract
  if (!lineageDigest || !current?.instructionContractDigest || !current.runtimeContinuityCatalog
    || lineageDigest === current.instructionContractDigest
    || creationManifestDigest === current.runtimeManifestDigest) return lineageDigest
  return resolveInstructionContractTransition({
    catalog: current.runtimeContinuityCatalog,
    sourceManifestDigest: creationManifestDigest,
    targetManifestDigest: current.runtimeManifestDigest,
    lineageInstructionContractDigest: lineageDigest,
  }) === current.instructionContractDigest ? current.instructionContractDigest : lineageDigest
}

/** The request tools the pinned runtime sends for the thread's frozen surface, whose identity the turn carries. */
export function threadRequestToolsDigest(context: CodexBindingContext, surfaceJson: string | null, turnToolSurfaceDigest: string): string {
  let surface: ReadyToolSurface
  try {
    surface = JSON.parse(surfaceJson || '') as ReadyToolSurface
  } catch {
    throw new CodexBindingRepositoryError('gateway_product_binding_mismatch')
  }
  if (surface?.toolSurfaceDigest !== turnToolSurfaceDigest || !Array.isArray(surface.dynamicTools)) {
    throw new CodexBindingRepositoryError('gateway_product_binding_mismatch')
  }
  return codexRequestToolsDigest(surface)
}

export function readLatestAliasGeneration(context: CodexBindingContext, aliasId: string): number | null {
  nonEmpty(aliasId, 'alias_identity_invalid')
  const row = context.db.prepare(`
      SELECT MAX(alias_generation) AS alias_generation
        FROM codex_thread_bindings
       WHERE ready_conversation_alias = ?
    `).get<{ alias_generation: number | null }>(aliasId)
  return typeof row?.alias_generation === 'number' ? row.alias_generation : null
}

export function assertThreadArchiveEligible(context: CodexBindingContext, threadId: string): void {
  nonEmpty(threadId, 'archive_thread_identity_invalid')
  const thread = context.db.prepare(`
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
    && Boolean(context.db.prepare(`
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
  const fence = context.db.prepare(`
      SELECT thread_binding_id FROM codex_thread_dispatch_fences
       WHERE thread_binding_id = ? LIMIT 1
    `).get(thread.thread_binding_id)
  if (fence && !cleanupIntent) throw new CodexBindingRepositoryError('thread_archive_fence_active')
  const unresolved = context.db.prepare(`
      SELECT ready_run_id FROM codex_turn_bindings
       WHERE thread_binding_id = ?
         AND (
           turn_start_reservation_released_at IS NULL
           OR (product_terminal_digest IS NULL AND host_failure_product_terminal_digest IS NULL)
         )
       LIMIT 1
    `).get(thread.thread_binding_id)
  if (unresolved && !cleanupIntent) throw new CodexBindingRepositoryError('thread_archive_turn_unresolved')
  const unresolvedCall = context.db.prepare(`
      SELECT call_row.codex_call_id
        FROM codex_tool_call_bindings call_row
        JOIN codex_turn_bindings turn_row ON turn_row.ready_run_id = call_row.ready_run_id
       WHERE turn_row.thread_binding_id = ?
         AND (call_row.receipt_id IS NULL OR call_row.result_digest IS NULL)
       LIMIT 1
    `).get(thread.thread_binding_id)
  if (unresolvedCall && !cleanupIntent) throw new CodexBindingRepositoryError('thread_archive_call_unresolved')
  const descendant = context.db.prepare(`
      SELECT thread_binding_id FROM codex_thread_bindings
       WHERE (codex_parent_thread_id = ? OR codex_forked_from_id = ?)
         AND NOT (
           thread_materialization_kind = 'native_fork'
           AND materialization_state = 'confirmed'
           AND history_source_thread_binding_id = ?
         )
       LIMIT 1
    `).get(threadId, threadId, thread.thread_binding_id)
  if (descendant) throw new CodexBindingRepositoryError('thread_archive_descendant_exists')
}

export function admissionNativeInheritedContractDigest(
  context: CodexBindingContext,
  target: Pick<ThreadBindingRow, 'runtime_manifest_digest' | 'protocol_schema_digest'>,
  input: CodexAdmittedBindingInput,
): string {
  return nativeInheritedContractDigest({
    runtimeManifestDigest: target.runtime_manifest_digest,
    protocolSchemaDigest: target.protocol_schema_digest,
    toolSurfaceSnapshotDigest: input.prepared.readyToolSurface.surfaceSnapshotDigest,
    instructionContractDigest: input.instructionContractDigest,
    model: input.codexModel,
    threadConfig: resolveCodexNativeModelSettings(readUpstreamProfileSnapshot(
      context,
      input.upstreamProfileSnapshotRef, input.upstreamProfileSnapshotDigest,
    )).threadConfig,
  })
}

export function readNativeInheritedContractDigest(context: CodexBindingContext, thread: ThreadBindingRow): string {
  if (!thread.native_inherited_contract_digest || !thread.tool_surface_snapshot_digest
    || !thread.instruction_contract_digest || !thread.codex_model) {
    throw new CodexBindingRepositoryError('native_inherited_contract_missing')
  }
  const digest = nativeInheritedContractDigest({
    runtimeManifestDigest: thread.runtime_manifest_digest,
    protocolSchemaDigest: thread.protocol_schema_digest,
    toolSurfaceSnapshotDigest: thread.tool_surface_snapshot_digest,
    instructionContractDigest: thread.instruction_contract_digest,
    model: thread.codex_model,
    threadConfig: resolveCodexNativeModelSettings(readUpstreamProfileSnapshot(
      context,
      thread.upstream_profile_snapshot_ref, thread.upstream_profile_snapshot_digest,
    )).threadConfig,
  })
  if (digest !== thread.native_inherited_contract_digest) {
    throw new CodexBindingRepositoryError('native_inherited_contract_mismatch')
  }
  return digest
}

export function readUpstreamProfileSnapshot(
  context: CodexBindingContext,
  snapshotRef: string | null,
  snapshotDigest: string | null,
): CodexUpstreamProfileSnapshot {
  if (!snapshotRef || !snapshotDigest) {
    throw new CodexBindingRepositoryError('upstream_profile_snapshot_unavailable')
  }
  const row = context.db.prepare(`
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

export function readActiveThreadByAlias(context: CodexBindingContext, aliasId: string): ThreadBindingRow | null {
  return context.db.prepare(`
      SELECT * FROM codex_thread_bindings
       WHERE ready_conversation_alias = ? AND retired_at IS NULL LIMIT 1
    `).get<ThreadBindingRow>(aliasId) || null
}

export function validateEmptyAlias(context: CodexBindingContext, input: CodexEmptyAliasGenerationInput): void {
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

export function insertEmptyAliasGenerationInOpenTransaction(
  context: CodexBindingContext,
  input: CodexEmptyAliasGenerationInput,
): {
  threadBindingId: string
  aliasId: string
  aliasGeneration: number
} {
  validateEmptyAlias(context, input)
  context.db.prepare(`
      INSERT INTO codex_thread_bindings (
        thread_binding_id, ready_conversation_alias, alias_generation, ready_scope_id,
        runtime_manifest_digest, protocol_schema_digest,
        thread_materialization_kind, materialization_state,
        revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'fresh_start', 'confirmed', 1, ?, ?)
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
  const readback = requireThread(context, input.threadBindingId)
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

export function nextThreadBindingId(
  context: CodexBindingContext,
  aliasId: string,
  aliasGeneration: number,
  evidenceDigest: string,
): string {
  return `codex-thread-${digest({ aliasId, aliasGeneration, evidenceDigest }).slice(0, 32)}`
}

export function requireThread(context: CodexBindingContext, threadBindingId: string): ThreadBindingRow {
  const row = context.db.prepare(`
      SELECT * FROM codex_thread_bindings WHERE thread_binding_id = ?
    `).get<ThreadBindingRow>(threadBindingId)
  if (!row) throw new CodexBindingRepositoryError('thread_binding_not_found')
  return row
}

export function requireTurn(context: CodexBindingContext, readyRunId: string): TurnBindingRow {
  const row = context.db.prepare(`
      SELECT * FROM codex_turn_bindings WHERE ready_run_id = ?
    `).get<TurnBindingRow>(readyRunId)
  if (!row) throw new CodexBindingRepositoryError('turn_binding_not_found')
  return row
}

export function requireProcessLease(context: CodexBindingContext, processLeaseId: string): CodexProcessLeaseRow {
  const row = context.db.prepare(`
      SELECT * FROM codex_sidecar_process_leases WHERE process_lease_id = ?
    `).get<ProcessLeaseDbRow>(processLeaseId)
  if (!row) throw new CodexBindingRepositoryError('process_lease_not_found')
  return processLeaseFromRow(row)
}

export function recordThreadArchiveIntentInOpenTransaction(context: CodexBindingContext, input: {
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
  const intent = recordCodexThreadArchiveIntentInOpenTransaction(context.db, {
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

export function requireThreadArchiveIntent(context: CodexBindingContext, input: {
  threadBindingId: string
  sourceKind: CodexThreadArchiveSourceKind
  readyRunId: string | null
  retirementTransactionDigest: string
}): { intentDigest: string } {
  const row = context.db.prepare(`
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
