import { projectCodexHeadActionProjection } from '../codex-action-surface'
import { CodexBindingRepositoryError } from '../codex-binding-error'
import { resolveExplicitRetryTailPlan } from '../codex-history-continuity-policy'
import { canonicalJson, digestCanonicalJson, resolveCodexNativeModelSettings } from '../codex-model-gateway-contract'
import { assertReadyToolSurface, assertReadyTurnToolAuthorization, buildReadyBoundTurnToolAuthorization } from '../codex-tool-surface'
import { digestCodexUserInput } from '../codex-user-input'
import type { CodexBindingContext } from './context'
import { assertFreshRootInheritance } from './continuity'
import { admissionNativeInheritedContractDigest, readActiveThreadByAlias, readNativeInheritedContractDigest, readUpstreamProfileSnapshot, requireThread, requireTurn } from './core'
import { buildCodexIngressAdmissionReceipt, buildCodexIngressAdmittedDigest, changes, nonEmpty, safePositive } from './shared'
import type { CodexAdmittedBindingInput, ThreadBindingRow } from './types'
import { codexThreadPredatesMaterializationRecords } from '../codex-thread-materialization'

// Atomic admission of a product run into its thread and turn bindings.

export function admitProductBindings(context: CodexBindingContext, input: CodexAdmittedBindingInput): {
  threadBindingId: string
  readyRunId: string
  threadState: 'unstarted' | 'loaded'
} {
  return context.immediate(() => context.self.admitProductBindingsInOpenTransaction(input))
}

export function admitProductBindingsInOpenTransaction(context: CodexBindingContext, input: CodexAdmittedBindingInput): {
  threadBindingId: string
  readyRunId: string
  threadState: 'unstarted' | 'loaded'
} {
  if (context.db.inTransaction !== true) {
    throw new CodexBindingRepositoryError('product_admission_transaction_missing')
  }
  validateAdmission(context, input)
  if (context.currentContract && (
    input.runtimeManifestDigest !== context.currentContract.runtimeManifestDigest
    || input.protocolSchemaDigest !== context.currentContract.protocolSchemaDigest
  )) throw new CodexBindingRepositoryError('current_runtime_contract_mismatch')
  assertReadyParents(context, input)
  const { ingressAdmittedDigest: _, ...digestInput } = input
    const existing = readActiveThreadByAlias(context, input.prepared.conversationAlias.aliasId)
    if (existing?.codex_thread_id && input.continuationCandidate) {
      const candidate = input.continuationCandidate
      const nextThreadConfig = resolveCodexNativeModelSettings(readUpstreamProfileSnapshot(
        context,
        input.upstreamProfileSnapshotRef,
        input.upstreamProfileSnapshotDigest,
      )).threadConfig
      if (candidate.model !== input.codexModel
        || canonicalJson(candidate.threadConfig) !== canonicalJson(nextThreadConfig)
        || candidate.isolatedThreadCwd !== input.isolatedThreadCwd
        || candidate.instructionContractDigest !== input.instructionContractDigest
        || canonicalJson(candidate.currentToolSurface)
          !== canonicalJson(input.prepared.readyToolSurface)) {
        throw new CodexBindingRepositoryError('continuation_candidate_mismatch')
      }
    }
    const continuation = existing?.codex_thread_id
      ? input.continuationCandidate
        ? context.self.resolveSameThreadContinuation({
            aliasId: input.prepared.conversationAlias.aliasId,
            aliasGeneration: input.prepared.conversationAlias.aliasGeneration,
            candidate: input.continuationCandidate,
          })
        : null
      : null
    if (existing?.codex_thread_id && (!continuation || continuation.kind !== 'ready_same_thread')) {
      throw new CodexBindingRepositoryError(
        continuation?.reason || 'continuation_contract_unavailable',
      )
    }
    if (existing?.thread_start_reservation_set_id && !codexThreadPredatesMaterializationRecords(existing.thread_materialization_kind)) {
      readNativeInheritedContractDigest(context, existing)
    }
    if (existing?.thread_materialization_kind === 'fresh_root_with_tail') {
      assertFreshRootInheritance(context, existing, input)
    }
    if (input.prepared.ingress.attemptKind === 'user_ingress') {
      const admissionRef = input.prepared.ingress.actionAdmissionRef
      if (!admissionRef) throw new CodexBindingRepositoryError('action_admission_ref_missing')
      const currentProjection = projectCodexHeadActionProjection(context.self.readHeadActionFacts({
        aliasId: input.prepared.conversationAlias.aliasId,
        aliasGeneration: input.prepared.conversationAlias.aliasGeneration,
        currentRuntimeManifestDigest: input.runtimeManifestDigest,
        currentProtocolSchemaDigest: input.protocolSchemaDigest,
        headContractBlocker: continuation?.reason ?? null,
      }))
      const expectedRef = currentProjection.actionHeadIdentity && {
        headProjectionDigest: currentProjection.evidenceDigest,
        actionProjectionVersion: currentProjection.actionProjectionVersion,
        actionHeadIdentity: currentProjection.actionHeadIdentity,
      }
      if (!expectedRef
        || digestCanonicalJson(admissionRef) !== digestCanonicalJson(expectedRef)
        || currentProjection.actions.send_new_message.availability !== 'ready') {
        throw new CodexBindingRepositoryError('action_admission_ref_stale')
      }
      if (digestCanonicalJson(input.prepared.ingress.uncommittedUserTail || [])
        !== digestCanonicalJson(context.self.readLiveUncommittedUserTail(input.threadBindingId))) {
        throw new CodexBindingRepositoryError('ordinary_uncommitted_tail_stale')
      }
    } else {
      const ingress = input.prepared.ingress
      if (ingress.actionAdmissionRef !== undefined) {
        throw new CodexBindingRepositoryError('retry_action_admission_ref_forbidden')
      }
      if (!existing || !existing.history_seed_digest
        || ingress.selectedHistorySeedItemRef?.threadBindingId !== existing.thread_binding_id
        || ingress.selectedHistorySeedItemRef.historySeedDigest !== existing.history_seed_digest
        || ingress.modelVisibleRootOriginRef?.originUserMessageId
          !== ingress.canonicalCurrentInputRef.messageId
        || ingress.modelVisibleRootOriginRef.inputDigest
          !== digestCodexUserInput(ingress.canonicalCurrentInputRef.input)
        || ingress.controlAuditMessageRef?.messageId !== ingress.originUserMessageId
        || ingress.predecessorPresentationRef?.readyRunId !== ingress.predecessorRunId) {
        throw new CodexBindingRepositoryError('retry_identity_ref_invalid')
      }
      const liveTail = context.self.readLiveUncommittedUserTail(existing.thread_binding_id)
      const tailPlan = resolveExplicitRetryTailPlan(liveTail, ingress.selectedHistorySeedItemRef)
      if (tailPlan.kind !== 'eligible'
        || digestCanonicalJson(ingress.uncommittedUserTail) !== digestCanonicalJson(liveTail)
        || digestCanonicalJson(ingress.uncommittedTailAssignments) !== digestCanonicalJson(tailPlan.assignments)) {
        throw new CodexBindingRepositoryError('retry_selected_seed_stale')
      }
      const root = context.self.readProductTurnRuntime(ingress.modelVisibleRootOriginRef.sourceReadyRunId)
      if (root.readyScopeId !== input.prepared.readyToolHostIdentity.scopeId
        || root.prepared.ingress.attemptKind !== 'user_ingress'
        || digestCanonicalJson(root.prepared)
          !== ingress.modelVisibleRootOriginRef.sourceIngressContractDigest
        || digestCanonicalJson(root.prepared.sourceTrustedEnvironmentRef)
          !== digestCanonicalJson(input.prepared.sourceTrustedEnvironmentRef)
        || ingress.currentTrustedEnvironmentRef?.trustedWorkbenchMode
          !== input.prepared.sourceTrustedEnvironmentRef.workbenchMode
        || root.prepared.ingress.canonicalCurrentInputRef.messageId
          !== ingress.modelVisibleRootOriginRef.originUserMessageId
        || digestCodexUserInput(root.prepared.ingress.canonicalCurrentInputRef.input)
          !== ingress.modelVisibleRootOriginRef.inputDigest) {
        throw new CodexBindingRepositoryError('retry_root_ref_invalid')
      }
      if (existing.thread_materialization_kind === 'fresh_root_with_tail'
        && existing.history_source_thread_binding_id !== root.threadBindingId) {
        throw new CodexBindingRepositoryError('retry_native_inherited_contract_mismatch')
      }
      const predecessorPresentation = context.self.readProductTurnPresentation(
        ingress.predecessorRunId as string,
        {
          requestedWorkbenchMode: input.prepared.sourceTrustedEnvironmentRef.workbenchMode,
          trustedWorkbenchMode: input.prepared.sourceTrustedEnvironmentRef.workbenchMode,
        },
      )
      if (predecessorPresentation.presentationDigest
        !== ingress.predecessorPresentationRef?.presentationDigest
        || predecessorPresentation.actionProjection.retry_failed_task.availability !== 'ready') {
        throw new CodexBindingRepositoryError('retry_predecessor_presentation_stale')
      }
      if (context.self.readProductTurnSuccessorId(ingress.predecessorRunId as string)) {
        throw new CodexBindingRepositoryError('retry_predecessor_stale')
      }
    }
    let thread: ThreadBindingRow
    if (input.reservation.existingThread) {
      if (
        !existing
        || existing.thread_binding_id !== input.threadBindingId
        || existing.alias_generation !== input.prepared.conversationAlias.aliasGeneration
        || existing.ready_scope_id !== input.prepared.readyToolHostIdentity.scopeId
        || existing.retired_at !== null
        || existing.continuation_blocked_at !== null
        || !existing.codex_thread_id
        || !existing.thread_start_reservation_set_id
      ) throw new CodexBindingRepositoryError('active_thread_binding_mismatch')
      const surfaceJson = canonicalJson(input.prepared.readyToolSurface)
      if (
        existing.tool_surface_snapshot_digest === null
        && existing.tool_surface_json === null
      ) {
        const backfilled = context.db.prepare(`
            UPDATE codex_thread_bindings
               SET tool_surface_snapshot_digest = ?, tool_surface_json = ?,
                   revision = revision + 1, updated_at = ?
             WHERE thread_binding_id = ? AND revision = ?
               AND tool_surface_digest = ?
               AND tool_surface_snapshot_digest IS NULL AND tool_surface_json IS NULL
          `).run(
          input.prepared.readyToolSurface.surfaceSnapshotDigest,
          surfaceJson,
          input.admittedAt,
          existing.thread_binding_id,
          existing.revision,
          input.prepared.readyToolSurface.toolSurfaceDigest,
        )
        if (changes(backfilled) !== 1) {
          throw new CodexBindingRepositoryError('tool_surface_backfill_cas_failed')
        }
        thread = requireThread(context, input.threadBindingId)
      } else {
        if (
          existing.tool_surface_snapshot_digest !== input.prepared.readyToolSurface.surfaceSnapshotDigest
          || existing.tool_surface_json !== surfaceJson
        ) throw new CodexBindingRepositoryError('tool_surface_snapshot_mismatch')
        thread = existing
      }
    } else {
      if (
        !existing
        || existing.thread_binding_id !== input.threadBindingId
        || existing.alias_generation !== input.prepared.conversationAlias.aliasGeneration
        || existing.ready_scope_id !== input.prepared.readyToolHostIdentity.scopeId
        || (existing.thread_materialization_kind !== 'fresh_root_with_tail'
          && (existing.runtime_manifest_digest !== input.runtimeManifestDigest
            || existing.protocol_schema_digest !== input.protocolSchemaDigest))
        || existing.thread_start_reservation_set_id !== null
        || existing.codex_thread_id !== null
        || existing.retired_at !== null
      ) throw new CodexBindingRepositoryError('empty_alias_binding_mismatch')
      const threadMember = input.reservation.members[0]
      const hydrated = context.db.prepare(`
          UPDATE codex_thread_bindings
             SET thread_start_reservation_set_id = ?,
                 thread_start_reservation_member_id = ?,
                 thread_start_reservation_admitted_at = ?,
                 thread_start_request_id = ?, isolated_thread_cwd = ?,
                 tool_surface_digest = ?, tool_surface_snapshot_digest = ?,
                 tool_surface_json = ?, instruction_contract_digest = ?,
                 codex_model_provider_id = 'ready_gateway', codex_model = ?,
                 upstream_profile_snapshot_ref = ?, upstream_profile_snapshot_digest = ?,
                 native_inherited_contract_digest = ?,
                 revision = revision + 1, updated_at = ?
           WHERE thread_binding_id = ? AND revision = ?
             AND thread_start_reservation_set_id IS NULL AND retired_at IS NULL
        `).run(
        input.reservation.reservationSetId,
        threadMember.reservationId,
        input.admittedAt,
        input.prepared.ingressBinding.requestId,
        input.isolatedThreadCwd,
        input.prepared.readyToolSurface.toolSurfaceDigest,
        input.prepared.readyToolSurface.surfaceSnapshotDigest,
        canonicalJson(input.prepared.readyToolSurface),
        input.instructionContractDigest,
        input.codexModel,
        input.upstreamProfileSnapshotRef,
        input.upstreamProfileSnapshotDigest,
        admissionNativeInheritedContractDigest(context, existing, input),
        input.admittedAt,
        existing.thread_binding_id,
        existing.revision,
      )
      if (changes(hydrated) !== 1) throw new CodexBindingRepositoryError('empty_alias_hydration_cas_failed')
      thread = requireThread(context, input.threadBindingId)
    }

    const turnMember = input.reservation.members[input.reservation.members.length - 1]
    const boundAuthorization = buildReadyBoundTurnToolAuthorization({
      authorization: input.prepared.readyTurnToolAuthorization,
      readySessionKey: input.prepared.conversationAlias.aliasId,
      readyTaskId: input.prepared.taskId,
      readyRunId: input.prepared.runId,
      scopeId: input.prepared.readyToolHostIdentity.scopeId,
      toolSurfaceDigest: input.prepared.readyToolSurface.toolSurfaceDigest,
      turnContractDigest: input.turnContractDigest,
      resourceAnchorDigest: input.prepared.resourceAnchorDigest,
      createdAt: input.admittedAt,
    })
    context.db.prepare(`
        INSERT INTO codex_turn_bindings (
          ready_run_id,
          ready_task_id,
          thread_binding_id,
          codex_thread_id,
          start_reservation_set_id,
          start_reservation_required_member_count,
          turn_start_reservation_member_id,
          turn_start_reservation_admitted_at,
          turn_request_id,
          origin_user_message_id,
          message_visibility_epoch,
          ingress_admitted_revision,
          ingress_admitted_digest,
          ingress_admitted_at,
          attempt_kind,
          predecessor_run_id,
          history_parity_evidence_digest,
          current_thread_read_evidence_digest,
          continuation_contract_digest,
          tool_surface_digest,
          authorization_snapshot_digest,
          authorization_snapshot_json,
          product_budget_seed_json,
          effective_codex_model,
          effective_upstream_snapshot_ref,
          effective_upstream_snapshot_digest,
          additional_context_digest,
          ready_memory_snapshot_json,
          ready_memory_snapshot_digest,
          ready_memory_state_revision,
          ready_memory_revocation_revision,
          turn_contract_digest,
          ingress_json,
          revision,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
      input.prepared.runId,
      input.prepared.taskId,
      thread.thread_binding_id,
      thread.codex_thread_id,
      input.reservation.reservationSetId,
      input.reservation.members.length,
      turnMember.reservationId,
      input.admittedAt,
      input.turnRequestId,
      input.prepared.ingress.kind === 'user_ingress'
        ? input.prepared.ingress.originUserMessageId
        : null,
      input.messageVisibilityEpoch,
      input.ingressAdmittedRevision,
      input.ingressAdmittedDigest,
      input.admittedAt,
      input.prepared.ingress.attemptKind,
      input.prepared.ingress.predecessorRunId || null,
      input.prepared.ingress.historyParityEvidenceDigest || null,
      input.prepared.ingress.currentThreadReadEvidenceDigest || null,
      input.prepared.ingress.continuationContractDigest || null,
      input.prepared.readyToolSurface.toolSurfaceDigest,
      boundAuthorization.authorizationSnapshotDigest,
      canonicalJson(boundAuthorization),
      canonicalJson(input.prepared.productBudgetSeed),
      input.codexModel,
      input.upstreamProfileSnapshotRef,
      input.upstreamProfileSnapshotDigest,
      input.additionalContextDigest,
      canonicalJson(input.prepared.readyMemorySnapshot),
      input.prepared.readyMemorySnapshot.snapshotDigest,
      input.prepared.readyMemorySnapshot.stateRevision,
      input.prepared.readyMemorySnapshot.revocationRevision,
      input.turnContractDigest,
      canonicalJson(buildCodexIngressAdmissionReceipt(digestInput)),
      input.admittedAt,
      input.admittedAt,
    )
    context.db.prepare(`
        INSERT INTO codex_thread_dispatch_fences (
          thread_binding_id, owner_main_boot_id, operation_kind,
          owner_ready_run_id, acquired_at, revision
        ) VALUES (?, ?, 'product_turn', ?, ?, 1)
      `).run(thread.thread_binding_id, input.ownerMainBootId, input.prepared.runId, input.admittedAt)

    const turn = requireTurn(context, input.prepared.runId)
    const fence = context.db.prepare(`
        SELECT thread_binding_id, owner_ready_run_id, revision
          FROM codex_thread_dispatch_fences WHERE thread_binding_id = ?
      `).get<{ thread_binding_id: string; owner_ready_run_id: string; revision: number }>(
      thread.thread_binding_id,
    )
    if (
      turn.thread_binding_id !== thread.thread_binding_id
      || turn.start_reservation_set_id !== input.reservation.reservationSetId
      || fence?.owner_ready_run_id !== input.prepared.runId
      || fence.revision !== 1
    ) throw new CodexBindingRepositoryError('admission_readback_mismatch')
    return {
      threadBindingId: thread.thread_binding_id,
      readyRunId: turn.ready_run_id,
      threadState: thread.codex_thread_id ? 'loaded' : 'unstarted',
    }
}

export function validateAdmission(context: CodexBindingContext, input: CodexAdmittedBindingInput): void {
  const { prepared, reservation } = input
  try {
    assertReadyToolSurface(prepared.readyToolSurface)
    assertReadyTurnToolAuthorization(prepared.readyTurnToolAuthorization)
  } catch {
    throw new CodexBindingRepositoryError('admission_tool_snapshot_invalid')
  }
  if (prepared.readyTurnToolAuthorization.allowedToolNames.some(
    (toolName) => !prepared.readyToolSurface.toolNames.includes(toolName),
  )) throw new CodexBindingRepositoryError('admission_tool_authorization_mismatch')
  if (
    reservation.scopeId !== prepared.readyToolHostIdentity.scopeId
    || reservation.reservationSetId !== prepared.ingressBinding.reservationSetId
    || reservation.reservationEvidenceDigest !== prepared.ingressBinding.reservationEvidenceDigest
    || reservation.members.length !== (reservation.existingThread ? 1 : 2)
    || reservation.members[reservation.members.length - 1]?.method !== 'turn/start'
    || (!reservation.existingThread && reservation.members[0]?.method !== 'thread/start')
  ) throw new CodexBindingRepositoryError('admission_reservation_mismatch')
  safePositive(input.ingressAdmittedRevision, 'ingress_revision_invalid')
  if (!Number.isSafeInteger(input.messageVisibilityEpoch) || input.messageVisibilityEpoch < 0) {
    throw new CodexBindingRepositoryError('message_visibility_epoch_invalid')
  }
  for (const value of [
    input.ownerMainBootId,
    input.admittedAt,
    input.ingressAdmittedDigest,
    input.threadBindingId,
    input.isolatedThreadCwd,
    input.turnRequestId,
    input.runtimeManifestDigest,
    input.protocolSchemaDigest,
    input.instructionContractDigest,
    input.codexModel,
    input.upstreamProfileSnapshotRef,
    input.upstreamProfileSnapshotDigest,
    input.additionalContextDigest,
    input.turnContractDigest,
    input.readyParentReceipt.messageTimestamp,
    input.readyParentReceipt.messageMetaDigest,
    input.readyParentReceipt.executionBindingDigest,
  ]) nonEmpty(value, 'admission_identity_invalid')
  const { ingressAdmittedDigest: _, ...digestInput } = input
  if (input.ingressAdmittedDigest !== buildCodexIngressAdmittedDigest(digestInput)) {
    throw new CodexBindingRepositoryError('ingress_admission_digest_mismatch')
  }
}

export function assertReadyParents(context: CodexBindingContext, input: CodexAdmittedBindingInput): void {
  const scope = context.db.prepare(`
      SELECT id, message_visibility_epoch
        FROM chat_conversations WHERE id = ? AND closed_at IS NULL
    `).get<{ id: string; message_visibility_epoch: number }>(
    input.prepared.readyToolHostIdentity.scopeId,
  )
  const message = context.db.prepare(`
      SELECT message.id, message.conversation_id, message.role, message.content,
             message.timestamp, message.meta_json, message.message_visibility_epoch
        FROM chat_messages message
        JOIN chat_conversations scope ON scope.id = message.conversation_id
       WHERE message.id = ? AND scope.closed_at IS NULL
         AND message.message_visibility_epoch = scope.message_visibility_epoch
    `).get<{
    id: string
    conversation_id: string
    role: string
    content: string
    timestamp: string
    meta_json: string
    message_visibility_epoch: number
  }>(
    input.prepared.ingress.originUserMessageId,
  )
  const canonicalText = input.prepared.ingress.canonicalCurrentInputRef.input
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('')
  const controlAuditMessageRef = input.prepared.ingress.controlAuditMessageRef
  const auditMessageMatches = input.prepared.ingress.attemptKind === 'explicit_retry'
    ? controlAuditMessageRef
      ? controlAuditMessageRef.messageId === message?.id
        && controlAuditMessageRef.inputDigest === digestCodexUserInput([{
          type: 'text',
          text: message?.content || '',
          text_elements: [],
        }])
      : false
    : message?.content === canonicalText
  const task = context.db.prepare(`
      SELECT task_id, run_id, scope_id, status, execution_binding_json
        FROM task_projections WHERE task_id = ?
    `).get<{
    task_id: string
    run_id: string
    scope_id: string
    status: string
    execution_binding_json: string | null
  }>(input.prepared.taskId)
  const run = context.db.prepare(`
      SELECT run_id, task_id, scope_id, status, execution_binding_json
        FROM run_meta WHERE run_id = ?
    `).get<{
    run_id: string
    task_id: string | null
    scope_id: string | null
    status: string
    execution_binding_json: string | null
  }>(input.prepared.runId)
  if (!scope || !message || !task || !run) {
    throw new CodexBindingRepositoryError('ready_parent_mismatch')
  }
  let messageMetaDigest = ''
  let taskExecutionBindingDigest = ''
  let runExecutionBindingDigest = ''
  try {
    if (message) messageMetaDigest = digestCanonicalJson(JSON.parse(message.meta_json))
    taskExecutionBindingDigest = digestCanonicalJson(JSON.parse(task.execution_binding_json || ''))
    runExecutionBindingDigest = digestCanonicalJson(JSON.parse(run.execution_binding_json || ''))
  } catch {
    throw new CodexBindingRepositoryError('ready_parent_receipt_invalid')
  }
  if (
    scope.id !== input.prepared.readyToolHostIdentity.scopeId
    || scope.message_visibility_epoch !== input.messageVisibilityEpoch
    || message.conversation_id !== input.prepared.readyToolHostIdentity.scopeId
    || message.role !== 'user'
    || !auditMessageMatches
    || message.timestamp !== input.readyParentReceipt.messageTimestamp
    || message.message_visibility_epoch !== input.messageVisibilityEpoch
    || messageMetaDigest !== input.readyParentReceipt.messageMetaDigest
    || task?.run_id !== input.prepared.runId
    || task.scope_id !== input.prepared.readyToolHostIdentity.scopeId
    || task.status !== 'running'
    || !task.execution_binding_json
    || run?.task_id !== input.prepared.taskId
    || run.scope_id !== input.prepared.readyToolHostIdentity.scopeId
    || run.status !== 'running'
    || run.execution_binding_json !== task.execution_binding_json
    || taskExecutionBindingDigest !== input.readyParentReceipt.executionBindingDigest
    || runExecutionBindingDigest !== input.readyParentReceipt.executionBindingDigest
  ) throw new CodexBindingRepositoryError('ready_parent_mismatch')
}
