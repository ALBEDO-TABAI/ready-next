import { CodexBindingRepositoryError } from '../codex-binding-error'
import { nativeInheritedContractDigest } from '../codex-history-continuity-policy'
import { canonicalJson, digestCanonicalJson, resolveCodexNativeModelSettings } from '../codex-model-gateway-contract'
import { resolveRuntimeCompatibilitySet, type RuntimeCompatibilitySet, type RuntimeOperation } from '../codex-runtime-compatibility'
import { resolveSameThreadContinuationContract, type SameThreadContinuation, type SameThreadContinuationCandidate, type StoredThreadContinuationContract } from '../codex-same-thread-continuation'
import { assertReadyToolSurface, type ReadyToolSurface } from '../codex-tool-surface'
import type { CodexBindingContext } from './context'
import { admissionNativeInheritedContractDigest, effectiveInstructionContractDigest, readActiveThreadByAlias, readNativeInheritedContractDigest, readUpstreamProfileSnapshot, requireThread } from './core'
import { nonEmpty } from './shared'
import type { CodexActiveAliasBindingRead, CodexAdmittedBindingInput, CodexStoredContinuationRead, ThreadBindingRow } from './types'

// Whether a stored thread can continue under the current runtime and Ready contract.

export function readActiveAliasBinding(context: CodexBindingContext, aliasId: string): CodexActiveAliasBindingRead | null {
  nonEmpty(aliasId, 'alias_identity_invalid')
  const row = readActiveThreadByAlias(context, aliasId)
  if (!row) return null
  let toolSurface: ReadyToolSurface | null = null
  if (row.tool_surface_json !== null) {
    try {
      toolSurface = JSON.parse(row.tool_surface_json) as ReadyToolSurface
      assertReadyToolSurface(toolSurface)
    } catch {
      throw new CodexBindingRepositoryError('tool_surface_snapshot_invalid')
    }
  }
  const fence = context.db.prepare(`
      SELECT 1 AS present FROM codex_thread_dispatch_fences
       WHERE thread_binding_id = ? LIMIT 1
    `).get<{ present: number }>(row.thread_binding_id)
  return {
    threadBindingId: row.thread_binding_id,
    aliasId: row.ready_conversation_alias,
    aliasGeneration: row.alias_generation,
    readyScopeId: row.ready_scope_id,
    codexThreadId: row.codex_thread_id,
    codexSessionId: row.codex_session_id,
    isolatedThreadCwd: row.isolated_thread_cwd,
    toolSurface,
    materializationKind: row.thread_materialization_kind,
    materializationState: row.materialization_state,
    historySeedDigest: row.history_seed_digest,
    hasActiveFence: fence?.present === 1,
    continuationBlockedAt: row.continuation_blocked_at,
    continuationBlockedReason: row.continuation_blocked_reason,
    retiredAt: row.retired_at,
    instructionContractDigest: effectiveInstructionContractDigest(
      context,
      row.instruction_contract_digest,
      row.runtime_manifest_digest,
    ),
  }
}

export function readStoredContinuationContract(context: CodexBindingContext, input: {
  aliasId: string
  aliasGeneration: number
}): CodexStoredContinuationRead {
  const thread = readActiveThreadByAlias(context, input.aliasId)
  if (!thread || thread.alias_generation !== input.aliasGeneration || thread.retired_at) {
    throw new CodexBindingRepositoryError('active_alias_generation_mismatch')
  }
  if (!thread.codex_thread_id) {
    throw new CodexBindingRepositoryError('continuation_contract_unavailable')
  }
  const stored = readStoredThreadContract(context, thread)
  return {
    stored,
    runtimeSourceManifestDigests: readRuntimeSourceManifestDigests(
      context,
      thread.thread_binding_id,
    ),
  }
}

export function readFreshRootSourceContinuationContract(context: CodexBindingContext, threadBindingId: string): CodexStoredContinuationRead {
  const target = requireThread(context, threadBindingId)
  if (target.thread_materialization_kind !== 'fresh_root_with_tail'
    || !target.history_source_thread_binding_id) {
    throw new CodexBindingRepositoryError('fresh_root_history_source_missing')
  }
  const source = requireThread(context, target.history_source_thread_binding_id)
  return {
    stored: readStoredThreadContract(context, source),
    runtimeSourceManifestDigests: readRuntimeSourceManifestDigests(context, source.thread_binding_id),
  }
}

export function readStoredThreadContract(context: CodexBindingContext, thread: ThreadBindingRow): StoredThreadContinuationContract {
  if (!thread.codex_model || !thread.isolated_thread_cwd
    || !thread.instruction_contract_digest || !thread.tool_surface_json) {
    throw new CodexBindingRepositoryError('continuation_contract_unavailable')
  }
  let readyToolSurface: ReadyToolSurface
  try {
    readyToolSurface = JSON.parse(thread.tool_surface_json) as ReadyToolSurface
    assertReadyToolSurface(readyToolSurface)
  } catch {
    throw new CodexBindingRepositoryError('tool_surface_snapshot_invalid')
  }
  const threadConfig = resolveCodexNativeModelSettings(readUpstreamProfileSnapshot(
    context,
    thread.upstream_profile_snapshot_ref,
    thread.upstream_profile_snapshot_digest,
  )).threadConfig
  return {
    model: thread.codex_model,
    threadConfig,
    isolatedThreadCwd: thread.isolated_thread_cwd,
    instructionContractDigest: effectiveInstructionContractDigest(
      context,
      thread.instruction_contract_digest,
      thread.runtime_manifest_digest,
    ),
    readyToolSurface,
  }
}

export function readRuntimeSourceManifestDigests(context: CodexBindingContext, threadBindingId: string): string[] {
  const thread = requireThread(context, threadBindingId)
  const sourceRows = context.db.prepare(`
      SELECT runtime_manifest_digest FROM codex_sidecar_process_leases
       WHERE connection_epoch IN (
         SELECT thread_start_rpc_connection_epoch FROM codex_thread_bindings
          WHERE thread_binding_id = ? AND thread_start_rpc_connection_epoch IS NOT NULL
         UNION
         SELECT turn_start_rpc_connection_epoch FROM codex_turn_bindings
          WHERE thread_binding_id = ? AND turn_start_rpc_connection_epoch IS NOT NULL
         UNION
         SELECT attempt.connection_epoch
           FROM codex_manual_compaction_dispatch_attempts attempt
           JOIN codex_manual_compaction_bindings manual
             ON manual.manual_compaction_id = attempt.manual_compaction_id
          WHERE manual.thread_binding_id = ?
         UNION
         SELECT connection_epoch FROM codex_thread_resume_evidence
          WHERE thread_binding_id = ?
       )
    `).all<{ runtime_manifest_digest: string }>(
    threadBindingId,
    threadBindingId,
    threadBindingId,
    threadBindingId,
  )
  return [...new Set([
    thread.runtime_manifest_digest,
    ...sourceRows.map((row) => row.runtime_manifest_digest),
  ])].sort()
}

export function resolveRuntimeOperationForThread(context: CodexBindingContext, input: {
  threadBindingId: string
  operation: RuntimeOperation
}): RuntimeCompatibilitySet {
  const catalog = context.currentContract?.runtimeContinuityCatalog
  const targetManifestDigest = context.currentContract?.runtimeManifestDigest
  if (!catalog || !targetManifestDigest) {
    throw new CodexBindingRepositoryError('runtime_continuity_catalog_unavailable')
  }
  return resolveRuntimeCompatibilitySet({
    catalog,
    sourceManifestDigests: readRuntimeSourceManifestDigests(context, input.threadBindingId),
    targetManifestDigest,
    operation: input.operation,
  })
}

export function resolveHeadMaterializationRuntime(context: CodexBindingContext, threadBindingId: string): RuntimeCompatibilitySet | null {
  const target = requireThread(context, threadBindingId)
  if (target.thread_materialization_kind !== 'fresh_root_with_tail') return null
  if (!context.self.freshRootRequiresReseed(threadBindingId)) return null
  if (!target.history_source_thread_binding_id) {
    throw new CodexBindingRepositoryError('fresh_root_history_source_missing')
  }
  return context.self.resolveRuntimeOperationForThread({
    threadBindingId: target.history_source_thread_binding_id,
    operation: 'reseed_uncommitted_tail',
  })
}

export function freshRootRequiresReseed(context: CodexBindingContext, threadBindingId: string): boolean {
  const target = requireThread(context, threadBindingId)
  if (target.thread_materialization_kind !== 'fresh_root_with_tail') return false
  return context.self.readLiveUncommittedUserTail(threadBindingId)
    .some((item) => item.policy === 'untrusted_text_history')
}

export function resolveFreshRootInheritance(context: CodexBindingContext, input: {
  threadBindingId: string
  candidate: SameThreadContinuationCandidate
}): SameThreadContinuation {
  const target = requireThread(context, input.threadBindingId)
  if (target.thread_materialization_kind !== 'fresh_root_with_tail'
    || !target.history_source_thread_binding_id) {
    throw new CodexBindingRepositoryError('fresh_root_history_source_missing')
  }
  if (!context.self.freshRootRequiresReseed(input.threadBindingId)) {
    throw new CodexBindingRepositoryError('fresh_root_reseed_not_required')
  }
  const source = requireThread(context, target.history_source_thread_binding_id)
  const stored = readStoredThreadContract(context, source)
  const runtime = context.self.resolveRuntimeOperationForThread({
    threadBindingId: source.thread_binding_id,
    operation: 'reseed_uncommitted_tail',
  })
  const decision = resolveSameThreadContinuationContract({
    stored,
    candidate: {
      ...input.candidate,
      isolatedThreadCwd: stored.isolatedThreadCwd,
      cwdAvailable: true,
    },
    runtime,
  })
  if (decision.kind !== 'ready_same_thread'
    || stored.readyToolSurface.surfaceSnapshotDigest
      === input.candidate.currentToolSurface.surfaceSnapshotDigest) return decision
  const unsigned = {
    contract: 'ready_fresh_root_inheritance_v1',
    kind: 'requires_new_context' as const,
    reason: 'native_tool_definition_changed' as const,
    runtimeEvidenceDigest: runtime.evidenceDigest,
    sourceToolSurfaceSnapshotDigest: stored.readyToolSurface.surfaceSnapshotDigest,
    candidateToolSurfaceSnapshotDigest: input.candidate.currentToolSurface.surfaceSnapshotDigest,
  }
  return {
    ...unsigned,
    evidenceDigest: digestCanonicalJson(unsigned),
    toolCompatibility: decision.toolCompatibility,
  }
}

export function assertRuntimeOperationForThread(
  context: CodexBindingContext,
  threadBindingId: string,
  operation: RuntimeOperation,
): RuntimeCompatibilitySet {
  const compatibility = context.self.resolveRuntimeOperationForThread({ threadBindingId, operation })
  if (compatibility.kind !== 'compatible') {
    throw new CodexBindingRepositoryError(
      compatibility.kind === 'unsupported' ? 'runtime_unsupported' : 'runtime_unverified',
    )
  }
  return compatibility
}

export function resolveSameThreadContinuation(context: CodexBindingContext, input: {
  aliasId: string
  aliasGeneration: number
  candidate: SameThreadContinuationCandidate
}): SameThreadContinuation {
  const catalog = context.currentContract?.runtimeContinuityCatalog
  const targetManifestDigest = context.currentContract?.runtimeManifestDigest
  if (!catalog || !targetManifestDigest) {
    throw new CodexBindingRepositoryError('runtime_continuity_catalog_unavailable')
  }
  const source = context.self.readStoredContinuationContract(input)
  return resolveSameThreadContinuationContract({
    stored: source.stored,
    candidate: input.candidate,
    runtime: resolveRuntimeCompatibilitySet({
      catalog,
      sourceManifestDigests: source.runtimeSourceManifestDigests,
      targetManifestDigest,
      operation: 'ordinary_continuation',
    }),
  })
}

export function assertFreshRootInheritance(
  context: CodexBindingContext,
  target: ThreadBindingRow,
  input: CodexAdmittedBindingInput,
): void {
  if (target.thread_materialization_kind !== 'fresh_root_with_tail') return
  if (!context.self.freshRootRequiresReseed(target.thread_binding_id)) return
  const candidate = input.continuationCandidate
  if (!candidate) throw new CodexBindingRepositoryError('continuation_contract_unavailable')
  const expectedThreadConfig = resolveCodexNativeModelSettings(readUpstreamProfileSnapshot(
    context,
    input.upstreamProfileSnapshotRef,
    input.upstreamProfileSnapshotDigest,
  )).threadConfig
  if (candidate.model !== input.codexModel
    || canonicalJson(candidate.threadConfig) !== canonicalJson(expectedThreadConfig)
    || candidate.isolatedThreadCwd !== input.isolatedThreadCwd
    || candidate.instructionContractDigest !== input.instructionContractDigest
    || canonicalJson(candidate.currentToolSurface) !== canonicalJson(input.prepared.readyToolSurface)) {
    throw new CodexBindingRepositoryError('continuation_candidate_mismatch')
  }
  const decision = context.self.resolveFreshRootInheritance({
    threadBindingId: target.thread_binding_id,
    candidate,
  })
  if (decision.kind !== 'ready_same_thread') {
    throw new CodexBindingRepositoryError(decision.reason || 'continuation_contract_unavailable')
  }
  const source = requireThread(context, target.history_source_thread_binding_id!)
  readNativeInheritedContractDigest(context, source)
  const targetCandidateDigest = admissionNativeInheritedContractDigest(context, target, input)
  const sourceNonRuntimeDigest = nativeInheritedContractDigest({
    runtimeManifestDigest: target.runtime_manifest_digest,
    protocolSchemaDigest: target.protocol_schema_digest,
    toolSurfaceSnapshotDigest: source.tool_surface_snapshot_digest!,
    instructionContractDigest: effectiveInstructionContractDigest(
      context,
      source.instruction_contract_digest,
      source.runtime_manifest_digest,
    )!,
    model: source.codex_model!,
    threadConfig: resolveCodexNativeModelSettings(readUpstreamProfileSnapshot(
      context,
      source.upstream_profile_snapshot_ref,
      source.upstream_profile_snapshot_digest,
    )).threadConfig,
  })
  if (targetCandidateDigest !== sourceNonRuntimeDigest) {
    throw new CodexBindingRepositoryError('retry_native_inherited_contract_mismatch')
  }
}
