import { CodexBindingRepositoryError } from '../codex-binding-error'
import { canonicalJson, digestCanonicalJson } from '../codex-model-gateway-contract'
import { isPreparedCodexProductRun } from '../codex-product-run-preparer'
import { codexRequestToolsDigest } from '../codex-tool-surface'
import type { CodexBindingContext } from './context'
import { effectiveInstructionContractDigest } from './core'
import { isRecord, nonEmpty } from './shared'
import type { ClosedTurnUpstreamRouteRow, CodexPendingInteractionBindingRead, CodexProductCloseoutRead, CodexProductStartStateRead, CodexProductTurnRuntimeRead } from './types'

// Reads of a product turn binding and the runs it owns.

export function readOpenProductRunIds(context: CodexBindingContext): ReadonlySet<string> {
  const rows = context.db.prepare(`
      SELECT ready_run_id
        FROM codex_turn_bindings
       WHERE product_terminal_digest IS NULL
         AND host_failure_product_terminal_digest IS NULL
    `).all<Array<{ ready_run_id: string }>[number]>()
  return new Set(rows.map((row) => row.ready_run_id))
}

export function readArtifactStorageRetention(context: CodexBindingContext): {
  protectedRunIds: string[]
  collectibleRunIds: string[]
} {
  const rows = context.db.prepare(`
      SELECT turn.ready_run_id, turn.predecessor_run_id,
             turn.product_terminal_digest, turn.publication_receipt_digest,
             run.status
        FROM codex_turn_bindings turn
        LEFT JOIN run_meta run ON run.run_id = turn.ready_run_id
       ORDER BY turn.created_at, turn.ready_run_id
    `).all<{
    ready_run_id: string
    predecessor_run_id: string | null
    product_terminal_digest: string | null
    publication_receipt_digest: string | null
    status: string | null
  }>()
  const succeeded = new Set(rows.filter((row) => (
    row.status === 'done'
    && row.product_terminal_digest !== null
    && row.publication_receipt_digest !== null
  )).map((row) => row.ready_run_id))
  const successors = new Map<string, string>()
  for (const row of rows) {
    if (!row.predecessor_run_id) continue
    successors.set(row.predecessor_run_id, row.ready_run_id)
  }
  const protectedRunIds: string[] = []
  const collectibleRunIds: string[] = []
  for (const row of rows) {
    let tailRunId = row.ready_run_id
    for (let depth = 0; depth <= rows.length; depth += 1) {
      const successorRunId = successors.get(tailRunId)
      if (!successorRunId) break
      if (depth === rows.length) {
        throw new CodexBindingRepositoryError('artifact_retention_lineage_invalid')
      }
      tailRunId = successorRunId
    }
    if (succeeded.has(tailRunId)) collectibleRunIds.push(row.ready_run_id)
    else protectedRunIds.push(row.ready_run_id)
  }
  return { protectedRunIds, collectibleRunIds }
}

export function hasProductTurnBinding(context: CodexBindingContext, readyRunId: string): boolean {
  nonEmpty(readyRunId, 'ready_run_id_invalid')
  return Boolean(context.db.prepare(`
      SELECT 1 AS found FROM codex_turn_bindings WHERE ready_run_id = ? LIMIT 1
    `).get<{ found: number }>(readyRunId))
}

export function readActiveProductRunVisibilityIdentity(context: CodexBindingContext, readyRunId: string): {
  readyRunId: string
  readyScopeId: string
  readyAliasId: string
  aliasGeneration: number
  messageVisibilityEpoch: number
} | null {
  nonEmpty(readyRunId, 'ready_run_id_invalid')
  const row = context.db.prepare(`
      SELECT turn.ready_run_id,
             turn.message_visibility_epoch,
             binding.ready_scope_id,
             binding.ready_conversation_alias,
             binding.alias_generation
        FROM codex_turn_bindings turn
        JOIN codex_thread_bindings binding
          ON binding.thread_binding_id = turn.thread_binding_id
       WHERE turn.ready_run_id = ?
         AND binding.retired_at IS NULL
         AND turn.product_terminal_digest IS NULL
         AND turn.host_failure_product_terminal_digest IS NULL
       LIMIT 1
    `).get<{
    ready_run_id: string
    ready_scope_id: string
    ready_conversation_alias: string
    alias_generation: number
    message_visibility_epoch: number
  }>(readyRunId)
  return row ? {
    readyRunId: row.ready_run_id,
    readyScopeId: row.ready_scope_id,
    readyAliasId: row.ready_conversation_alias,
    aliasGeneration: row.alias_generation,
    messageVisibilityEpoch: row.message_visibility_epoch,
  } : null
}

export function readCommittedProductRunVisibilityIdentity(context: CodexBindingContext, readyRunId: string): {
  readyRunId: string
  readyScopeId: string
  readyAliasId: string
  aliasGeneration: number
  messageVisibilityEpoch: number
} | null {
  nonEmpty(readyRunId, 'ready_run_id_invalid')
  const row = context.db.prepare(`
      SELECT turn.ready_run_id,
             turn.message_visibility_epoch,
             binding.ready_scope_id,
             binding.ready_conversation_alias,
             binding.alias_generation
        FROM codex_turn_bindings turn
        JOIN codex_thread_bindings binding
          ON binding.thread_binding_id = turn.thread_binding_id
       WHERE turn.ready_run_id = ?
         AND (
           (turn.product_terminal_digest IS NOT NULL AND turn.product_closeout_at IS NOT NULL)
           OR
           (turn.host_failure_product_terminal_digest IS NOT NULL
             AND turn.host_failure_closeout_at IS NOT NULL)
         )
       LIMIT 1
    `).get<{
    ready_run_id: string
    ready_scope_id: string
    ready_conversation_alias: string
    alias_generation: number
    message_visibility_epoch: number
  }>(readyRunId)
  return row ? {
    readyRunId: row.ready_run_id,
    readyScopeId: row.ready_scope_id,
    readyAliasId: row.ready_conversation_alias,
    aliasGeneration: row.alias_generation,
    messageVisibilityEpoch: row.message_visibility_epoch,
  } : null
}

export function hasExactProductFence(context: CodexBindingContext, input: { readyRunId: string; threadBindingId: string }): boolean {
  nonEmpty(input.readyRunId, 'ready_run_id_invalid')
  nonEmpty(input.threadBindingId, 'thread_binding_id_invalid')
  return Boolean(context.db.prepare(`
      SELECT 1 AS found
        FROM codex_thread_dispatch_fences
       WHERE operation_kind = 'product_turn'
         AND owner_ready_run_id = ? AND thread_binding_id = ?
       LIMIT 1
    `).get<{ found: number }>(input.readyRunId, input.threadBindingId))
}

export function readPendingInteractionBinding(context: CodexBindingContext, input: {
  readyRunId: string
  readyScopeId: string
}): CodexPendingInteractionBindingRead | null {
  nonEmpty(input.readyRunId, 'ready_run_id_invalid')
  nonEmpty(input.readyScopeId, 'ready_scope_id_invalid')
  const row = context.db.prepare(`
      SELECT t.ready_run_id, t.ready_task_id, t.codex_thread_id, t.codex_turn_id,
             t.message_visibility_epoch,
             b.ready_scope_id, b.ready_conversation_alias, b.alias_generation,
             b.thread_binding_id
        FROM codex_turn_bindings t
        JOIN codex_thread_bindings b ON b.thread_binding_id = t.thread_binding_id
        JOIN codex_thread_dispatch_fences f
          ON f.thread_binding_id = t.thread_binding_id
         AND f.operation_kind = 'product_turn'
         AND f.owner_ready_run_id = t.ready_run_id
       WHERE t.ready_run_id = ? AND b.ready_scope_id = ?
         AND t.product_terminal_digest IS NULL
         AND t.host_failure_product_terminal_digest IS NULL
       LIMIT 1
    `).get<{
    ready_run_id: string
    ready_task_id: string
    codex_thread_id: string | null
    codex_turn_id: string | null
    ready_scope_id: string
    ready_conversation_alias: string
    alias_generation: number
    thread_binding_id: string
    message_visibility_epoch: number
  }>(input.readyRunId, input.readyScopeId)
  if (!row?.codex_thread_id || !row.codex_turn_id) return null
  return {
    readyRunId: row.ready_run_id,
    readyTaskId: row.ready_task_id,
    readyScopeId: row.ready_scope_id,
    readyAliasId: row.ready_conversation_alias,
    aliasGeneration: row.alias_generation,
    threadBindingId: row.thread_binding_id,
    codexThreadId: row.codex_thread_id,
    codexTurnId: row.codex_turn_id,
    messageVisibilityEpoch: row.message_visibility_epoch,
  }
}

export function readActiveUpstreamProfileUsages(context: CodexBindingContext): readonly {
  profileId: string
  snapshotDigest: string
}[] {
  const rows = context.db.prepare(`
      SELECT DISTINCT snapshot.profile_id, snapshot.snapshot_digest
        FROM codex_turn_bindings turn
        JOIN codex_thread_dispatch_fences fence
          ON fence.thread_binding_id = turn.thread_binding_id
         AND fence.operation_kind = 'product_turn'
         AND fence.owner_ready_run_id = turn.ready_run_id
         AND fence.quarantined_at IS NULL
        JOIN ready_model_gateway_profile_snapshots snapshot
          ON snapshot.snapshot_ref = turn.effective_upstream_snapshot_ref
       WHERE turn.product_terminal_digest IS NULL
         AND turn.host_failure_product_terminal_digest IS NULL
      UNION
      SELECT DISTINCT snapshot.profile_id, snapshot.snapshot_digest
        FROM codex_manual_compaction_bindings manual
        JOIN codex_thread_dispatch_fences fence
          ON fence.thread_binding_id = manual.thread_binding_id
         AND fence.operation_kind = 'manual_compaction'
         AND fence.owner_manual_compaction_id = manual.manual_compaction_id
         AND fence.quarantined_at IS NULL
        JOIN ready_model_gateway_profile_snapshots snapshot
          ON snapshot.snapshot_ref = manual.upstream_profile_snapshot_ref
       WHERE manual.consumed_at IS NULL
         AND manual.abandoned_at IS NULL
    `).all<Array<{ profile_id: string; snapshot_digest: string }>[number]>()
  return rows.map((row) => ({
    profileId: row.profile_id,
    snapshotDigest: row.snapshot_digest,
  }))
}

export function readActiveUpstreamProfileIds(context: CodexBindingContext): ReadonlySet<string> {
  return new Set(context.self.readActiveUpstreamProfileUsages().map((usage) => usage.profileId))
}

export function readProductTurnRuntime(context: CodexBindingContext, readyRunId: string): CodexProductTurnRuntimeRead {
  nonEmpty(readyRunId, 'ready_run_id_invalid')
  const row = context.db.prepare(`
      SELECT t.ready_run_id, t.ready_task_id, t.codex_thread_id, t.codex_turn_id,
             t.gateway_claimed_codex_turn_id, t.turn_request_id,
             t.start_reservation_set_id, t.turn_start_rpc_connection_epoch,
             t.revision AS turn_revision,
             t.tool_surface_digest, t.turn_contract_digest,
             t.message_visibility_epoch,
             t.effective_upstream_snapshot_ref, t.effective_upstream_snapshot_digest,
             t.ready_memory_snapshot_json, t.ready_memory_snapshot_digest,
             t.ready_memory_state_revision, t.ready_memory_revocation_revision,
             t.ingress_json, t.ingress_admitted_digest, t.ingress_admitted_at,
             b.thread_binding_id, b.ready_scope_id, b.ready_conversation_alias,
             b.alias_generation, b.isolated_thread_cwd, b.codex_model,
             b.instruction_contract_digest, b.runtime_manifest_digest AS thread_runtime_manifest_digest
        FROM codex_turn_bindings t
        JOIN codex_thread_bindings b ON b.thread_binding_id = t.thread_binding_id
       WHERE t.ready_run_id = ? LIMIT 1
    `).get<{
    ready_run_id: string
    ready_task_id: string
    codex_thread_id: string | null
    codex_turn_id: string | null
    gateway_claimed_codex_turn_id: string | null
    turn_request_id: string
    start_reservation_set_id: string
    tool_surface_digest: string
    turn_contract_digest: string
    message_visibility_epoch: number
    effective_upstream_snapshot_ref: string
    effective_upstream_snapshot_digest: string
    ready_memory_snapshot_json: string | null
    ready_memory_snapshot_digest: string | null
    ready_memory_state_revision: number | null
    ready_memory_revocation_revision: number | null
    ingress_json: string | null
    ingress_admitted_digest: string
    ingress_admitted_at: string
    thread_binding_id: string
    ready_scope_id: string
    ready_conversation_alias: string
    alias_generation: number
    isolated_thread_cwd: string | null
    codex_model: string | null
    instruction_contract_digest: string
    thread_runtime_manifest_digest: string
    turn_start_rpc_connection_epoch: string | null
    turn_revision: number
  }>(readyRunId)
  if (!row) throw new CodexBindingRepositoryError('product_turn_binding_missing')
  if (!row.ingress_json) throw new CodexBindingRepositoryError('product_turn_ingress_missing')
  let receipt: unknown
  try {
    receipt = JSON.parse(row.ingress_json)
  } catch {
    throw new CodexBindingRepositoryError('product_turn_ingress_invalid')
  }
  if (!isRecord(receipt)
    || receipt.contract !== 'codex_ingress_admission_v1'
    || !isPreparedCodexProductRun(receipt.prepared)
    || receipt.prepared.runId !== row.ready_run_id
    || receipt.prepared.taskId !== row.ready_task_id
    || receipt.prepared.readyToolHostIdentity.scopeId !== row.ready_scope_id
    || receipt.prepared.conversationAlias.aliasId !== row.ready_conversation_alias
    || receipt.prepared.conversationAlias.aliasGeneration !== row.alias_generation
    || receipt.messageVisibilityEpoch !== row.message_visibility_epoch
    || row.ready_memory_snapshot_json !== canonicalJson(receipt.prepared.readyMemorySnapshot)
    || row.ready_memory_snapshot_digest !== receipt.prepared.readyMemorySnapshot.snapshotDigest
    || row.ready_memory_state_revision !== receipt.prepared.readyMemorySnapshot.stateRevision
    || row.ready_memory_revocation_revision !== receipt.prepared.readyMemorySnapshot.revocationRevision
    || !row.isolated_thread_cwd
    || !row.codex_model
    || !row.turn_start_rpc_connection_epoch
    || receipt.prepared.readyToolSurface.toolSurfaceDigest !== row.tool_surface_digest
    || digestCanonicalJson(receipt) !== row.ingress_admitted_digest) {
    throw new CodexBindingRepositoryError('product_turn_ingress_invalid')
  }
  const ingress = receipt.prepared.ingress
  return {
    readyRunId: row.ready_run_id,
    readyTaskId: row.ready_task_id,
    readyScopeId: row.ready_scope_id,
    readyAliasId: row.ready_conversation_alias,
    aliasGeneration: row.alias_generation,
    threadBindingId: row.thread_binding_id,
    codexThreadId: row.codex_thread_id,
    codexTurnId: row.codex_turn_id,
    gatewayClaimedCodexTurnId: row.gateway_claimed_codex_turn_id,
    turnRequestId: row.turn_request_id,
    reservationSetId: row.start_reservation_set_id,
    toolSurfaceDigest: row.tool_surface_digest,
    requestToolsDigest: codexRequestToolsDigest(receipt.prepared.readyToolSurface),
    turnContractDigest: row.turn_contract_digest,
    instructionContractDigest: effectiveInstructionContractDigest(
      context,
      row.instruction_contract_digest,
      row.thread_runtime_manifest_digest,
    ),
    upstreamProfileSnapshotRef: row.effective_upstream_snapshot_ref,
    upstreamProfileSnapshotDigest: row.effective_upstream_snapshot_digest,
    isolatedThreadCwd: row.isolated_thread_cwd,
    codexModel: row.codex_model,
    prepared: receipt.prepared,
    ingress,
    admittedAt: row.ingress_admitted_at,
    messageVisibilityEpoch: row.message_visibility_epoch,
    turnStartConnectionEpoch: row.turn_start_rpc_connection_epoch,
    turnRevision: row.turn_revision,
  }
}

export function readProductTurnSuccessorId(context: CodexBindingContext, readyRunId: string): string | null {
  nonEmpty(readyRunId, 'ready_run_id_invalid')
  const rows = context.db.prepare(`
      SELECT ready_run_id
        FROM codex_turn_bindings
       WHERE predecessor_run_id = ?
         AND attempt_kind IN ('recovery_successor', 'checkpoint_successor', 'explicit_retry')
       ORDER BY created_at, ready_run_id
       LIMIT 2
    `).all<Array<{ ready_run_id: string }>[number]>(readyRunId)
  if (rows.length > 1) throw new CodexBindingRepositoryError('product_turn_successor_ambiguous')
  return rows[0]?.ready_run_id ?? null
}

export function readProductCloseout(context: CodexBindingContext, readyRunId: string): CodexProductCloseoutRead | null {
  nonEmpty(readyRunId, 'ready_run_id_invalid')
  const row = context.db.prepare(`
      SELECT product_terminal_digest, host_failure_product_terminal_digest,
             product_closeout_at, host_failure_closeout_at
        FROM codex_turn_bindings WHERE ready_run_id = ? LIMIT 1
    `).get<{
    product_terminal_digest: string | null
    host_failure_product_terminal_digest: string | null
    product_closeout_at: string | null
    host_failure_closeout_at: string | null
  }>(readyRunId)
  if (!row) throw new CodexBindingRepositoryError('product_turn_binding_missing')
  if (row.product_terminal_digest && row.host_failure_product_terminal_digest) {
    throw new CodexBindingRepositoryError('product_closeout_kind_conflict')
  }
  const productTerminalDigest = row.product_terminal_digest || row.host_failure_product_terminal_digest
  const productCloseoutAt = row.product_terminal_digest
    ? row.product_closeout_at
    : row.host_failure_closeout_at
  if (!productTerminalDigest || !productCloseoutAt) return null
  return {
    productTerminalDigest,
    productCloseoutAt,
  }
}

export function readProductStartState(context: CodexBindingContext, readyRunId: string): CodexProductStartStateRead {
  nonEmpty(readyRunId, 'ready_run_id_invalid')
  const row = context.db.prepare(`
      SELECT turn.codex_thread_id, turn.codex_turn_id,
             thread.thread_start_dispatch_intent_at,
             turn.turn_start_dispatch_intent_at,
             turn.host_failure_kind, turn.product_terminal_digest,
             turn.host_failure_product_terminal_digest
        FROM codex_turn_bindings turn
        JOIN codex_thread_bindings thread
          ON thread.thread_binding_id = turn.thread_binding_id
       WHERE turn.ready_run_id = ? LIMIT 1
    `).get<{
    codex_thread_id: string | null
    codex_turn_id: string | null
    thread_start_dispatch_intent_at: string | null
    turn_start_dispatch_intent_at: string | null
    host_failure_kind: string | null
    product_terminal_digest: string | null
    host_failure_product_terminal_digest: string | null
  }>(readyRunId)
  if (!row) throw new CodexBindingRepositoryError('product_turn_binding_missing')
  return {
    codexThreadId: row.codex_thread_id,
    codexTurnId: row.codex_turn_id,
    threadStartDispatchIntentAt: row.thread_start_dispatch_intent_at,
    turnStartDispatchIntentAt: row.turn_start_dispatch_intent_at,
    hostFailureKind: row.host_failure_kind,
    productCloseoutCommitted: Boolean(
      row.product_terminal_digest || row.host_failure_product_terminal_digest,
    ),
  }
}

export function readProductRunForThreadBinding(context: CodexBindingContext, threadBindingId: string): string {
  const row = context.db.prepare(`
      SELECT ready_run_id FROM codex_turn_bindings
       WHERE thread_binding_id = ? AND host_failure_product_terminal_digest IS NULL
       ORDER BY created_at ASC LIMIT 1
    `).get<{ ready_run_id: string }>(threadBindingId)
  if (!row) throw new CodexBindingRepositoryError('thread_product_run_not_found')
  return row.ready_run_id
}

export function readLatestClosedTurnUpstreamRoute(
  context: CodexBindingContext,
  threadBindingId: string,
): ClosedTurnUpstreamRouteRow | null {
  return context.db.prepare(`
      SELECT effective_codex_model, effective_upstream_snapshot_ref,
             effective_upstream_snapshot_digest
        FROM codex_turn_bindings
       WHERE thread_binding_id = ?
         AND fence_release_revision IS NOT NULL
         AND (
           (product_terminal_digest IS NOT NULL AND product_closeout_at IS NOT NULL)
           OR
           (host_failure_product_terminal_digest IS NOT NULL
             AND host_failure_closeout_at IS NOT NULL)
         )
       ORDER BY created_at DESC, ready_run_id DESC
       LIMIT 1
    `).get<ClosedTurnUpstreamRouteRow>(threadBindingId) || null
}
