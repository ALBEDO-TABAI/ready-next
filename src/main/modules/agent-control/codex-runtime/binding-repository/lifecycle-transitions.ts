import { classifyLifecycleOperation, type LifecycleOperationSnapshot } from '../../../../../shared/ipc-contracts/agent-lifecycle-snapshot'
import type { CodexBeginNewContextActionRef, CodexConversationContextBoundary } from '../../../../../shared/ipc-contracts/agent-runtime'
import { CodexBindingRepositoryError } from '../codex-binding-error'
import type { CodexBindingRepository } from '../codex-binding-repository'
import { CODEX_PRISTINE_FRESH_START_PREDICATE_SQL } from '../codex-binding-schema'
import { captureCodexBoundaryContext, codexBeginNewContextOperationId } from '../codex-context-boundary'
import { advanceCodexConversationMessageVisibilityInOpenTransaction, clearCodexImplicitConversationContextInOpenTransaction, closeCodexConversationScopeInOpenTransaction } from '../codex-conversation-scope-closure'
import { digestCanonicalJson } from '../codex-model-gateway-contract'
import type { CodexBindingContext } from './context'
import { insertEmptyAliasGenerationInOpenTransaction, nextThreadBindingId, readActiveThreadByAlias, recordThreadArchiveIntentInOpenTransaction, requireThread, validateEmptyAlias } from './core'
import { changes, digest, nonEmpty, safePositive } from './shared'
import type { CodexActiveAliasBindingRead, CodexEmptyAliasGenerationInput, ThreadBindingRow } from './types'

// Alias head transitions: new context, pristine refresh, reset and retirement.

export function buildBeginNewContextActionRef(context: CodexBindingContext, input: {
  scopeId: string
  scopeEpoch: number
  candidateEvidenceDigest: string
  consequenceDigest: string
  draftRevision: number | null
}): CodexBeginNewContextActionRef {
  const scope = context.db.prepare(`
      SELECT message_visibility_epoch FROM chat_conversations
       WHERE id = ? AND closed_at IS NULL LIMIT 1
    `).get<{ message_visibility_epoch: number }>(input.scopeId)
  if (!scope || scope.message_visibility_epoch !== input.scopeEpoch) {
    throw new CodexBindingRepositoryError('begin_new_context_scope_stale')
  }
  const source = context.db.prepare(`
      SELECT * FROM codex_thread_bindings
       WHERE ready_scope_id = ?
       ORDER BY (retired_at IS NULL) DESC, alias_generation DESC LIMIT 1
    `).get<ThreadBindingRow>(input.scopeId)
  if (!source) throw new CodexBindingRepositoryError('begin_new_context_source_missing')
  const active = readActiveThreadByAlias(context, source.ready_conversation_alias)
  if (active && active.thread_binding_id !== source.thread_binding_id) {
    throw new CodexBindingRepositoryError('begin_new_context_source_stale')
  }
  const sourceEvidenceDigest = digestCanonicalJson({
    contract: 'codex_begin_new_context_source_v1',
    scopeId: input.scopeId,
    scopeEpoch: input.scopeEpoch,
    threadBindingId: source.thread_binding_id,
    aliasGeneration: source.alias_generation,
    revision: source.revision,
    retiredAt: source.retired_at,
    retiredReason: source.retired_reason,
    retirementEvidenceDigest: source.retirement_evidence_digest,
  })
  const operationId = codexBeginNewContextOperationId({
    scopeId: input.scopeId,
    scopeEpoch: input.scopeEpoch,
    sourceEvidenceDigest,
    candidateEvidenceDigest: input.candidateEvidenceDigest,
    consequenceDigest: input.consequenceDigest,
    draftRevision: input.draftRevision,
  })
  const unsigned = {
    contract: 'codex_begin_new_context_action_v1' as const,
    operationId,
    scopeId: input.scopeId,
    scopeEpoch: input.scopeEpoch,
    sourceThreadBindingId: source.thread_binding_id,
    sourceAliasGeneration: source.alias_generation,
    sourceRevision: source.revision,
    sourceEvidenceDigest,
    candidateEvidenceDigest: input.candidateEvidenceDigest,
    consequenceDigest: input.consequenceDigest,
    draftRevision: input.draftRevision,
  }
  return { ...unsigned, digest: digestCanonicalJson(unsigned) }
}

export function beginNewContext(context: CodexBindingContext, input: {
  actionRef: CodexBeginNewContextActionRef
  issuedActionRef: CodexBeginNewContextActionRef | null
  assertRecoveryEligible: () => void
  runtimeManifestDigest: string
  protocolSchemaDigest: string
  committedAt: string
}): {
  boundary: CodexConversationContextBoundary
  invalidation: NonNullable<ReturnType<CodexBindingRepository['readActionSurfaceInvalidation']>>
  committed: boolean
} {
  return context.immediate(() => {
    const { digest: suppliedDigest, ...unsignedRef } = input.actionRef
    if (digestCanonicalJson(unsignedRef) !== suppliedDigest
      || codexBeginNewContextOperationId(input.actionRef) !== input.actionRef.operationId) {
      throw new CodexBindingRepositoryError('begin_new_context_action_ref_invalid')
    }
    const existing = context.self.readContextBoundaries({
      scopeId: input.actionRef.scopeId,
      scopeEpoch: input.actionRef.scopeEpoch,
    }).find((boundary) => boundary.operationId === input.actionRef.operationId)
    if (existing) {
      const stored = context.db.prepare(`SELECT boundary.source_evidence_digest, scope.closed_at
          FROM codex_conversation_context_boundaries boundary
          JOIN chat_conversations scope ON scope.id = boundary.ready_scope_id
          WHERE boundary.operation_id = ?`).get<{ source_evidence_digest: string; closed_at: string | null }>(existing.operationId)
      if (!stored || stored.source_evidence_digest !== input.actionRef.sourceEvidenceDigest
        || existing.sourceThreadBindingId !== input.actionRef.sourceThreadBindingId
        || existing.sourceAliasGeneration !== input.actionRef.sourceAliasGeneration
        || existing.sourceRevision !== input.actionRef.sourceRevision) {
        throw new CodexBindingRepositoryError('begin_new_context_action_ref_invalid')
      }
      const invalidation = context.self.readActionSurfaceInvalidation(input.actionRef.scopeId)
      if (!invalidation) throw new CodexBindingRepositoryError('begin_new_context_readback_missing')
      if (stored.closed_at || invalidation.scopeEpoch !== input.actionRef.scopeEpoch) {
        throw new CodexBindingRepositoryError('begin_new_context_scope_stale')
      }
      return { boundary: existing, invalidation, committed: false }
    }
    if (!input.issuedActionRef
      || digestCanonicalJson(input.actionRef) !== digestCanonicalJson(input.issuedActionRef)) {
      throw new CodexBindingRepositoryError('begin_new_context_action_ref_unissued')
    }
    const expectedRef = context.self.buildBeginNewContextActionRef({
      scopeId: input.issuedActionRef.scopeId,
      scopeEpoch: input.issuedActionRef.scopeEpoch,
      candidateEvidenceDigest: input.issuedActionRef.candidateEvidenceDigest,
      consequenceDigest: input.issuedActionRef.consequenceDigest,
      draftRevision: input.issuedActionRef.draftRevision,
    })
    if (digestCanonicalJson(expectedRef) !== digestCanonicalJson(input.issuedActionRef)) {
      throw new CodexBindingRepositoryError('begin_new_context_action_ref_stale')
    }
    input.assertRecoveryEligible()
    const source = requireThread(context, input.actionRef.sourceThreadBindingId)
    const active = readActiveThreadByAlias(context, source.ready_conversation_alias)
    if (active) {
      const lifecycle = classifyLifecycleOperation(context.self.readLifecycleOperation({
        aliasId: active.ready_conversation_alias,
        aliasGeneration: active.alias_generation,
      }).facts)
      if (!['idle_never_started', 'idle_ready_terminal_no_native', 'idle_native_thread']
        .includes(lifecycle)) {
        throw new CodexBindingRepositoryError('begin_new_context_source_busy')
      }
    }
    const previousVisibleMessageAnchor = context.db.prepare(`
        SELECT id FROM chat_messages
         WHERE conversation_id = ? AND message_visibility_epoch = ?
         ORDER BY timestamp DESC, id DESC LIMIT 1
      `).get<{ id: string }>(input.actionRef.scopeId, input.actionRef.scopeEpoch)?.id ?? null
    const preservedContext = captureCodexBoundaryContext(context.db, input.actionRef.scopeId, input.actionRef.scopeEpoch)
    const retirementEvidenceDigest = digestCanonicalJson({
      contract: 'codex_begin_new_context_retirement_v1',
      actionRef: input.actionRef,
    })
    if (active) {
      const retired = context.db.prepare(`
          UPDATE codex_thread_bindings
             SET retired_at = ?, retired_reason = 'publication_diverged',
                 retirement_evidence_digest = ?,
                 action_projection_sequence = action_projection_sequence + 1,
                 revision = revision + 1, updated_at = ?
           WHERE thread_binding_id = ? AND revision = ? AND retired_at IS NULL
        `).run(
        input.committedAt,
        retirementEvidenceDigest,
        input.committedAt,
        active.thread_binding_id,
        active.revision,
      )
      if (changes(retired) !== 1) {
        throw new CodexBindingRepositoryError('begin_new_context_source_cas_failed')
      }
      recordThreadArchiveIntentInOpenTransaction(context, {
        thread: requireThread(context, active.thread_binding_id),
        sourceKind: 'begin_new_context',
        retiredReason: 'publication_diverged',
        readyRunId: null,
        retirementEvidenceDigest,
        retirementTransactionDigest: digestCanonicalJson({
          operationId: input.actionRef.operationId,
          sourceThreadBindingId: active.thread_binding_id,
        }),
        retiredAt: input.committedAt,
      })
    }
    const maxGeneration = context.db.prepare(`
        SELECT MAX(alias_generation) AS max_generation FROM codex_thread_bindings
         WHERE ready_conversation_alias = ?
      `).get<{ max_generation: number | null }>(source.ready_conversation_alias)?.max_generation ?? 0
    const targetAliasGeneration = maxGeneration + 1
    const targetThreadBindingId = nextThreadBindingId(
      context,
      source.ready_conversation_alias,
      targetAliasGeneration,
      input.actionRef.operationId,
    )
    insertEmptyAliasGenerationInOpenTransaction(context, {
      threadBindingId: targetThreadBindingId,
      aliasId: source.ready_conversation_alias,
      aliasGeneration: targetAliasGeneration,
      readyScopeId: source.ready_scope_id,
      runtimeManifestDigest: input.runtimeManifestDigest,
      protocolSchemaDigest: input.protocolSchemaDigest,
      createdAt: input.committedAt,
    })
    clearCodexImplicitConversationContextInOpenTransaction(context.db, {
      scopeId: source.ready_scope_id,
      updatedAt: input.committedAt,
    })
    const unsignedBoundary = {
      operationId: input.actionRef.operationId,
      scopeId: source.ready_scope_id,
      scopeEpoch: input.actionRef.scopeEpoch,
      sourceThreadBindingId: source.thread_binding_id,
      sourceAliasGeneration: source.alias_generation,
      sourceRevision: input.actionRef.sourceRevision,
      targetThreadBindingId,
      targetAliasGeneration,
      previousVisibleMessageAnchor,
      preservedContextDigest: digestCanonicalJson(preservedContext),
      committedAt: input.committedAt,
    }
    const receiptDigest = digestCanonicalJson(unsignedBoundary)
    context.db.prepare(`
        INSERT INTO codex_conversation_context_boundaries (
          operation_id, ready_scope_id, message_visibility_epoch,
          source_thread_binding_id, source_alias_generation, source_revision,
          source_evidence_digest, target_thread_binding_id, target_alias_generation,
          previous_visible_message_anchor, preserved_context_json, committed_at, receipt_digest
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
      unsignedBoundary.operationId,
      unsignedBoundary.scopeId,
      unsignedBoundary.scopeEpoch,
      unsignedBoundary.sourceThreadBindingId,
      unsignedBoundary.sourceAliasGeneration,
      unsignedBoundary.sourceRevision,
      input.actionRef.sourceEvidenceDigest,
      unsignedBoundary.targetThreadBindingId,
      unsignedBoundary.targetAliasGeneration,
      unsignedBoundary.previousVisibleMessageAnchor,
      JSON.stringify(preservedContext),
      unsignedBoundary.committedAt,
      receiptDigest,
    )
    const boundary = context.self.readContextBoundaries({
      scopeId: source.ready_scope_id,
      scopeEpoch: input.actionRef.scopeEpoch,
    }).find((candidate) => candidate.operationId === input.actionRef.operationId)
    const invalidation = context.self.readActionSurfaceInvalidation(source.ready_conversation_alias)
    if (!boundary || boundary.receiptDigest !== receiptDigest || !invalidation
      || invalidation.aliasGeneration !== targetAliasGeneration) {
      throw new CodexBindingRepositoryError('begin_new_context_readback_missing')
    }
    return { boundary, invalidation, committed: true }
  })
}

export function refreshPristineFreshStartHeadAtomic(context: CodexBindingContext, input: {
  aliasId: string
  runtimeManifestDigest: string
  protocolSchemaDigest: string
  createdAt: string
  currentToolSurfaceDigest?: string
}):
  | { kind: 'current'; binding: CodexActiveAliasBindingRead }
  | { kind: 'refreshed'; binding: CodexActiveAliasBindingRead
      invalidation: NonNullable<ReturnType<CodexBindingRepository['readActionSurfaceInvalidation']>> }
  | { kind: 'reset_required' | 'missing' } {
  for (const value of [input.aliasId, input.runtimeManifestDigest,
    input.protocolSchemaDigest, input.createdAt]) nonEmpty(value, 'alias_restore_identity_invalid')
  if (input.currentToolSurfaceDigest !== undefined) {
    nonEmpty(input.currentToolSurfaceDigest, 'alias_restore_identity_invalid')
  }
  return context.immediate(() => {
    const active = readActiveThreadByAlias(context, input.aliasId)
    if (!active) return { kind: 'missing' }
    if (active.runtime_manifest_digest === input.runtimeManifestDigest
      && active.protocol_schema_digest === input.protocolSchemaDigest
      && (input.currentToolSurfaceDigest === undefined || active.tool_surface_digest === null
        || active.tool_surface_digest === input.currentToolSurfaceDigest)) {
      return { kind: 'current', binding: context.self.readActiveAliasBinding(input.aliasId)! }
    }
    const scope = context.db.prepare('SELECT message_visibility_epoch FROM chat_conversations WHERE id = ?')
      .get<{ message_visibility_epoch: number }>(active.ready_scope_id)
    if (scope) context.self.readContextBoundaries({ scopeId: active.ready_scope_id, scopeEpoch: scope.message_visibility_epoch })
    const pristine = context.db.prepare(`
        SELECT head.thread_binding_id, scope.message_visibility_epoch
          FROM codex_thread_bindings head
          JOIN chat_conversations scope ON scope.id = head.ready_scope_id
         WHERE head.thread_binding_id = ? AND (${CODEX_PRISTINE_FRESH_START_PREDICATE_SQL})
      `).get<{ thread_binding_id: string; message_visibility_epoch: number }>(active.thread_binding_id)
    if (!pristine) return { kind: 'reset_required' }
    const replacementEvidenceDigest = digest({
      kind: 'pristine_contract_refresh',
      aliasId: active.ready_conversation_alias,
      aliasGeneration: active.alias_generation,
      threadBindingId: active.thread_binding_id,
      scopeEpoch: pristine.message_visibility_epoch,
      previousRuntimeManifestDigest: active.runtime_manifest_digest,
      previousProtocolSchemaDigest: active.protocol_schema_digest,
      runtimeManifestDigest: input.runtimeManifestDigest,
      protocolSchemaDigest: input.protocolSchemaDigest,
    })
    const retired = context.db.prepare(`
        UPDATE codex_thread_bindings
           SET retired_at = ?, retired_reason = 'pristine_contract_refresh',
               retirement_evidence_digest = ?, action_projection_sequence = action_projection_sequence + 1,
               revision = revision + 1, updated_at = ?
         WHERE thread_binding_id = ? AND revision = ? AND retired_at IS NULL
      `).run(input.createdAt, replacementEvidenceDigest, input.createdAt,
      active.thread_binding_id, active.revision)
    if (changes(retired) !== 1) throw new CodexBindingRepositoryError('pristine_contract_refresh_cas_failed')
    const aliasGeneration = active.alias_generation + 1
    const replacement = insertEmptyAliasGenerationInOpenTransaction(context, {
      threadBindingId: nextThreadBindingId(context, input.aliasId, aliasGeneration, replacementEvidenceDigest),
      aliasId: input.aliasId, aliasGeneration, readyScopeId: active.ready_scope_id,
      runtimeManifestDigest: input.runtimeManifestDigest,
      protocolSchemaDigest: input.protocolSchemaDigest, createdAt: input.createdAt,
    })
    context.db.prepare(`
        UPDATE codex_thread_bindings SET action_projection_sequence = 1
         WHERE thread_binding_id = ? AND action_projection_sequence = 0
      `).run(replacement.threadBindingId)
    const binding = context.self.readActiveAliasBinding(input.aliasId)
    const invalidation = context.self.readActionSurfaceInvalidation(input.aliasId)
    if (!binding || !invalidation || invalidation.aliasGeneration !== aliasGeneration
      || invalidation.scopeEpoch !== pristine.message_visibility_epoch
      || invalidation.actionProjectionSequence !== 1) {
      throw new CodexBindingRepositoryError('pristine_contract_refresh_readback_mismatch')
    }
    return { kind: 'refreshed', binding, invalidation }
  })
}

export function createEmptyAliasGeneration(context: CodexBindingContext, input: CodexEmptyAliasGenerationInput): {
  threadBindingId: string
  aliasId: string
  aliasGeneration: number
} {
  validateEmptyAlias(context, input)
  return context.immediate(() => insertEmptyAliasGenerationInOpenTransaction(context, input))
}

export function createEmptyAliasGenerationInOpenTransaction(context: CodexBindingContext, input: CodexEmptyAliasGenerationInput): {
  threadBindingId: string
  aliasId: string
  aliasGeneration: number
} {
  validateEmptyAlias(context, input)
  if (context.db.inTransaction !== true) {
    throw new CodexBindingRepositoryError('alias_create_transaction_missing')
  }
  return insertEmptyAliasGenerationInOpenTransaction(context, input)
}

export function resetIdleAlias(context: CodexBindingContext, input: {
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
  archiveIntentDigest: string | null
  messageVisibilityEpoch: number
} {
  for (const value of [input.aliasId, input.retirementEvidenceDigest, input.resetAt]) {
    nonEmpty(value, 'alias_reset_identity_invalid')
  }
  safePositive(input.expectedGeneration, 'alias_generation_invalid')
  return context.immediate(() => {
    const thread = readActiveThreadByAlias(context, input.aliasId)
    if (!thread || thread.alias_generation !== input.expectedGeneration) {
      throw new CodexBindingRepositoryError('active_alias_generation_mismatch')
    }
    const fence = context.db.prepare(`
        SELECT thread_binding_id FROM codex_thread_dispatch_fences
         WHERE thread_binding_id = ? LIMIT 1
      `).get(thread.thread_binding_id)
    if (fence) throw new CodexBindingRepositoryError('alias_not_idle')
    const retired = context.db.prepare(`
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
    if (thread.codex_thread_id) context.self.assertThreadArchiveEligible(thread.codex_thread_id)
    const newGeneration = thread.alias_generation + 1
    const newThreadBindingId = nextThreadBindingId(
      context,
      thread.ready_conversation_alias,
      newGeneration,
      input.retirementEvidenceDigest,
    )
    insertEmptyAliasGenerationInOpenTransaction(context, {
      threadBindingId: newThreadBindingId,
      aliasId: thread.ready_conversation_alias,
      aliasGeneration: newGeneration,
      readyScopeId: thread.ready_scope_id,
      runtimeManifestDigest: thread.runtime_manifest_digest,
      protocolSchemaDigest: thread.protocol_schema_digest,
      createdAt: input.resetAt,
    })
    const visibility = advanceCodexConversationMessageVisibilityInOpenTransaction(context.db, {
      scopeId: thread.ready_scope_id,
      resetAt: input.resetAt,
    })
    const transactionDigest = digest({
      aliasId: thread.ready_conversation_alias,
      retiredGeneration: thread.alias_generation,
      newGeneration,
      newThreadBindingId,
      retirementEvidenceDigest: input.retirementEvidenceDigest,
    })
    const archiveIntentDigest = recordThreadArchiveIntentInOpenTransaction(context, {
      thread,
      sourceKind: 'idle_reset',
      retiredReason: 'user_reset',
      readyRunId: null,
      retirementEvidenceDigest: input.retirementEvidenceDigest,
      retirementTransactionDigest: transactionDigest,
      retiredAt: input.resetAt,
    })
    return {
      aliasId: thread.ready_conversation_alias,
      retiredGeneration: thread.alias_generation,
      newGeneration,
      newThreadBindingId,
      transactionDigest,
      archiveIntentDigest,
      messageVisibilityEpoch: visibility.messageVisibilityEpoch,
    }
  })
}

export function retireLegacyPreparedAlias(context: CodexBindingContext, input: {
  aliasId: string
  expectedGeneration: number
  action: 'reset' | 'close'
  retirementEvidenceDigest: string
  retiredAt: string
  currentRuntimeManifestDigest?: string
  currentProtocolSchemaDigest?: string
  onClosedInOpenTransaction?: (input: { conversationId: string; closedAt: string }) => void
}): {
  aliasId: string
  retiredGeneration: number
  newGeneration: number | null
  newThreadBindingId: string | null
  transactionDigest: string
  scopeClosureEvidenceDigest: string | null
} {
  for (const value of [input.aliasId, input.retirementEvidenceDigest, input.retiredAt]) {
    nonEmpty(value, 'legacy_alias_retirement_identity_invalid')
  }
  safePositive(input.expectedGeneration, 'alias_generation_invalid')
  return context.immediate(() => {
    const thread = readActiveThreadByAlias(context, input.aliasId)
    if (!thread || thread.alias_generation !== input.expectedGeneration) {
      throw new CodexBindingRepositoryError('active_alias_generation_mismatch')
    }
    const openTurns = context.db.prepare(`
        SELECT ready_run_id,
               CASE WHEN json_valid(ingress_json) = 1
                 THEN COALESCE(json_extract(ingress_json, '$.prepared.preparationContract'), '')
                 ELSE '' END AS preparation_contract
          FROM codex_turn_bindings
         WHERE thread_binding_id = ?
           AND product_terminal_digest IS NULL
           AND host_failure_product_terminal_digest IS NULL
         ORDER BY created_at ASC, ready_run_id ASC
      `).all<{ ready_run_id: string; preparation_contract: string }>(thread.thread_binding_id)
    if (openTurns.length === 0
      || openTurns.some((turn) => turn.preparation_contract === 'codex_product_run_e2')) {
      throw new CodexBindingRepositoryError('legacy_prepared_contract_missing')
    }
    const fence = context.db.prepare(`
        SELECT operation_kind, owner_ready_run_id
          FROM codex_thread_dispatch_fences WHERE thread_binding_id = ? LIMIT 1
      `).get<{ operation_kind: string; owner_ready_run_id: string | null }>(thread.thread_binding_id)
    if (fence && (fence.operation_kind !== 'product_turn'
      || !openTurns.some((turn) => turn.ready_run_id === fence.owner_ready_run_id))) {
      throw new CodexBindingRepositoryError('legacy_prepared_fence_mismatch')
    }
    context.db.prepare(`
        UPDATE codex_turn_bindings
           SET turn_start_reservation_released_at = COALESCE(
                 turn_start_reservation_released_at, ?
               ),
               turn_start_reservation_release_reason = COALESCE(
                 turn_start_reservation_release_reason, ?
               ),
               effect_authority_closed_at = COALESCE(effect_authority_closed_at, ?),
               revision = revision + 1,
               updated_at = ?
         WHERE thread_binding_id = ?
           AND product_terminal_digest IS NULL
           AND host_failure_product_terminal_digest IS NULL
           AND (json_valid(ingress_json) = 0
             OR COALESCE(json_extract(ingress_json, '$.prepared.preparationContract'), '')
                  != 'codex_product_run_e2')
      `).run(
      input.retiredAt,
      `legacy_prepared_contract_${input.action}`,
      input.retiredAt,
      input.retiredAt,
      thread.thread_binding_id,
    )
    context.db.prepare(`
        DELETE FROM codex_thread_dispatch_fences
         WHERE thread_binding_id = ? AND operation_kind = 'product_turn'
      `).run(thread.thread_binding_id)
    const retired = context.db.prepare(`
        UPDATE codex_thread_bindings
           SET retired_at = ?, retired_reason = ?, retirement_evidence_digest = ?,
               action_projection_sequence = action_projection_sequence + 1,
               revision = revision + 1, updated_at = ?
         WHERE thread_binding_id = ? AND revision = ? AND retired_at IS NULL
      `).run(
      input.retiredAt,
      input.action === 'reset' ? 'user_reset' : 'closed',
      input.retirementEvidenceDigest,
      input.retiredAt,
      thread.thread_binding_id,
      thread.revision,
    )
    if (changes(retired) !== 1) {
      throw new CodexBindingRepositoryError('legacy_alias_retirement_cas_failed')
    }
    let newGeneration: number | null = null
    let newThreadBindingId: string | null = null
    let scopeClosureEvidenceDigest: string | null = null
    if (input.action === 'reset') {
      if (!input.currentRuntimeManifestDigest || !input.currentProtocolSchemaDigest) {
        throw new CodexBindingRepositoryError('legacy_reset_current_contract_missing')
      }
      newGeneration = thread.alias_generation + 1
      newThreadBindingId = nextThreadBindingId(
        context,
        thread.ready_conversation_alias,
        newGeneration,
        input.retirementEvidenceDigest,
      )
      insertEmptyAliasGenerationInOpenTransaction(context, {
        threadBindingId: newThreadBindingId,
        aliasId: thread.ready_conversation_alias,
        aliasGeneration: newGeneration,
        readyScopeId: thread.ready_scope_id,
        runtimeManifestDigest: input.currentRuntimeManifestDigest,
        protocolSchemaDigest: input.currentProtocolSchemaDigest,
        createdAt: input.retiredAt,
      })
      advanceCodexConversationMessageVisibilityInOpenTransaction(context.db, {
        scopeId: thread.ready_scope_id,
        resetAt: input.retiredAt,
      })
    } else {
      const transactionSeed = digest({
        aliasId: thread.ready_conversation_alias,
        retiredGeneration: thread.alias_generation,
        action: input.action,
        retirementEvidenceDigest: input.retirementEvidenceDigest,
      })
      scopeClosureEvidenceDigest = closeCodexConversationScopeInOpenTransaction(context.db, {
        scopeId: thread.ready_scope_id,
        closedAt: input.retiredAt,
        closeEvidenceDigest: transactionSeed,
      }).closeEvidenceDigest
      input.onClosedInOpenTransaction?.({
        conversationId: thread.ready_scope_id,
        closedAt: input.retiredAt,
      })
    }
    const transactionDigest = digest({
      aliasId: thread.ready_conversation_alias,
      retiredGeneration: thread.alias_generation,
      action: input.action,
      newGeneration,
      newThreadBindingId,
      retirementEvidenceDigest: input.retirementEvidenceDigest,
      scopeClosureEvidenceDigest,
    })
    return {
      aliasId: thread.ready_conversation_alias,
      retiredGeneration: thread.alias_generation,
      newGeneration,
      newThreadBindingId,
      transactionDigest,
      scopeClosureEvidenceDigest,
    }
  })
}

export function retireIdleAliasForClose(context: CodexBindingContext, input: {
  aliasId: string
  expectedGeneration: number
  expectedSnapshot: Extract<
    LifecycleOperationSnapshot,
    'idle_never_started' | 'idle_ready_terminal_no_native' | 'idle_native_thread'
  >
  retirementEvidenceDigest: string
  retiredAt: string
  idleThreadReadDigest: string | null
  onClosedInOpenTransaction: (input: { conversationId: string; closedAt: string }) => void
}): {
  aliasId: string
  retiredGeneration: number
  codexThreadId: string | null
  lastCommittedReadyTerminalTransactionDigest: string | null
  lastCommittedProductTerminalDigest: string | null
  transactionDigest: string
  archiveIntentDigest: string | null
  scopeClosureEvidenceDigest: string
} {
  for (const value of [input.aliasId, input.retirementEvidenceDigest, input.retiredAt]) {
    nonEmpty(value, 'alias_close_identity_invalid')
  }
  safePositive(input.expectedGeneration, 'alias_generation_invalid')
  if (
    (input.expectedSnapshot === 'idle_native_thread') !== Boolean(input.idleThreadReadDigest)
  ) throw new CodexBindingRepositoryError('alias_close_thread_readback_invalid')

  return context.immediate(() => {
    const thread = readActiveThreadByAlias(context, input.aliasId)
    if (!thread || thread.alias_generation !== input.expectedGeneration) {
      throw new CodexBindingRepositoryError('active_alias_generation_mismatch')
    }
    const operation = context.self.readLifecycleOperation({
      aliasId: input.aliasId,
      aliasGeneration: input.expectedGeneration,
    })
    if (classifyLifecycleOperation(operation.facts) !== input.expectedSnapshot) {
      throw new CodexBindingRepositoryError('alias_not_idle')
    }
    const unresolvedTurn = context.db.prepare(`
        SELECT ready_run_id FROM codex_turn_bindings
         WHERE thread_binding_id = ?
           AND (
             turn_start_reservation_released_at IS NULL
             OR (product_terminal_digest IS NULL
               AND host_failure_product_terminal_digest IS NULL)
           )
         LIMIT 1
      `).get(thread.thread_binding_id)
    if (unresolvedTurn) throw new CodexBindingRepositoryError('alias_close_turn_unresolved')

    const latestTerminal = context.db.prepare(`
        SELECT product_terminal_digest, host_failure_product_terminal_digest
          FROM codex_turn_bindings
         WHERE thread_binding_id = ?
           AND (product_terminal_digest IS NOT NULL
             OR host_failure_product_terminal_digest IS NOT NULL)
         ORDER BY COALESCE(product_closeout_at, host_failure_closeout_at, updated_at) DESC,
                  created_at DESC, ready_run_id DESC
         LIMIT 1
      `).get<{
      product_terminal_digest: string | null
      host_failure_product_terminal_digest: string | null
    }>(thread.thread_binding_id)
    const lastTerminalDigest = latestTerminal?.product_terminal_digest
      || latestTerminal?.host_failure_product_terminal_digest
      || null
    if (
      input.expectedSnapshot === 'idle_never_started'
      && (thread.codex_thread_id !== null || lastTerminalDigest !== null)
    ) throw new CodexBindingRepositoryError('alias_close_snapshot_mismatch')
    if (
      input.expectedSnapshot === 'idle_ready_terminal_no_native'
      && (thread.codex_thread_id !== null || lastTerminalDigest === null)
    ) throw new CodexBindingRepositoryError('alias_close_snapshot_mismatch')
    if (
      input.expectedSnapshot === 'idle_native_thread'
      && (thread.codex_thread_id === null || lastTerminalDigest === null)
    ) throw new CodexBindingRepositoryError('alias_close_snapshot_mismatch')

    const retired = context.db.prepare(`
        UPDATE codex_thread_bindings
           SET retired_at = ?, retired_reason = 'closed',
               retirement_evidence_digest = ?, revision = revision + 1, updated_at = ?
         WHERE thread_binding_id = ? AND revision = ? AND retired_at IS NULL
      `).run(
      input.retiredAt,
      input.retirementEvidenceDigest,
      input.retiredAt,
      thread.thread_binding_id,
      thread.revision,
    )
    if (changes(retired) !== 1) {
      throw new CodexBindingRepositoryError('alias_close_cas_failed')
    }
    if (thread.codex_thread_id) context.self.assertThreadArchiveEligible(thread.codex_thread_id)

    const transactionDigest = digest({
      aliasId: thread.ready_conversation_alias,
      retiredGeneration: thread.alias_generation,
      codexThreadId: thread.codex_thread_id,
      expectedSnapshot: input.expectedSnapshot,
      retirementEvidenceDigest: input.retirementEvidenceDigest,
      lastTerminalDigest,
      idleThreadReadDigest: input.idleThreadReadDigest,
    })
    const archiveIntentDigest = recordThreadArchiveIntentInOpenTransaction(context, {
      thread,
      sourceKind: 'idle_close',
      retiredReason: 'closed',
      readyRunId: null,
      retirementEvidenceDigest: input.retirementEvidenceDigest,
      retirementTransactionDigest: transactionDigest,
      retiredAt: input.retiredAt,
    })
    const scopeClosure = closeCodexConversationScopeInOpenTransaction(context.db, {
      scopeId: thread.ready_scope_id,
      closedAt: input.retiredAt,
      closeEvidenceDigest: transactionDigest,
    })
    input.onClosedInOpenTransaction({
      conversationId: thread.ready_scope_id,
      closedAt: input.retiredAt,
    })

    return {
      aliasId: thread.ready_conversation_alias,
      retiredGeneration: thread.alias_generation,
      codexThreadId: thread.codex_thread_id,
      lastCommittedReadyTerminalTransactionDigest:
        input.expectedSnapshot === 'idle_ready_terminal_no_native' ? lastTerminalDigest : null,
      lastCommittedProductTerminalDigest:
        input.expectedSnapshot === 'idle_native_thread' ? lastTerminalDigest : null,
      transactionDigest,
      archiveIntentDigest,
      scopeClosureEvidenceDigest: scopeClosure.closeEvidenceDigest,
    }
  })
}
