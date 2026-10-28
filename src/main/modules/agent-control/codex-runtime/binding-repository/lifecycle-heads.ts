import type { LifecycleOperationFacts } from '../../../../../shared/ipc-contracts/agent-lifecycle-snapshot'
import type { CodexConversationContextBoundary, ProductTurnReceipt } from '../../../../../shared/ipc-contracts/agent-runtime'
import type { CodexHeadActionBlocker, CodexHeadActionFacts } from '../codex-action-surface'
import { CodexBindingRepositoryError } from '../codex-binding-error'
import { readCodexContextBoundaries } from '../codex-context-boundary'
import { readCodexClosedConversationScope } from '../codex-conversation-scope-closure'
import { resolveExplicitRetryTailPlan } from '../codex-history-continuity-policy'
import { digestCanonicalJson } from '../codex-model-gateway-contract'
import { readNativeCoverage } from '../codex-native-coverage-reader'
import { readProductTurnPresentation as readProductTurnPresentationFromDb, readProductTurnPresentations as readProductTurnPresentationsFromDb, type ProductTurnActionContext } from '../codex-product-turn-presentation'
import type { CodexTerminalFacts } from '../codex-terminal-facts'
import { digestCodexUserInput } from '../codex-user-input'
import type { CodexBindingContext } from './context'
import { readActiveThreadByAlias, requireThread, requireThreadArchiveIntent, requireTurn } from './core'
import { codexLifecycleActionRetirementDigest, nonEmpty, safePositive } from './shared'
import { readLatestClosedTurnUpstreamRoute } from './turns'
import type { CodexLifecycleActionCloseoutRead, CodexLifecycleCloseoutRead, CodexLifecycleOperationRead, CodexManualCompactionRouteRead, CodexUncommittedUserTailItem, ProductTurnHeadReadSnapshot, TurnBindingRow } from './types'
import { codexThreadPredatesMaterializationRecords } from '../codex-thread-materialization'

// Head, lifecycle and presentation reads behind the conversation action surface.

export function readContextBoundaries(context: CodexBindingContext, input: {
  scopeId: string
  scopeEpoch: number
}): CodexConversationContextBoundary[] {
  return readCodexContextBoundaries(context.db, input)
}

export function readHistoryOnlyScope(context: CodexBindingContext, aliasId: string): {
  scopeId: string
  scopeEpoch: number
  sourceAliasGeneration: number
  evidenceDigest: string
} | null {
  if (readActiveThreadByAlias(context, aliasId)) return null
  const row = context.db.prepare(`
      SELECT thread.ready_scope_id, thread.alias_generation, thread.thread_binding_id,
             thread.revision, thread.retired_at, thread.retired_reason,
             thread.retirement_evidence_digest, scope.message_visibility_epoch
        FROM codex_thread_bindings thread
        JOIN chat_conversations scope ON scope.id = thread.ready_scope_id
       WHERE thread.ready_conversation_alias = ? AND scope.closed_at IS NULL
       ORDER BY thread.alias_generation DESC LIMIT 1
    `).get<{
    ready_scope_id: string
    alias_generation: number
    thread_binding_id: string
    revision: number
    retired_at: string | null
    retired_reason: string | null
    retirement_evidence_digest: string | null
    message_visibility_epoch: number
  }>(aliasId)
  if (!row || !row.retired_at || !row.retired_reason || !row.retirement_evidence_digest) return null
  const unsigned = {
    contract: 'codex_history_only_scope_v1',
    scopeId: row.ready_scope_id,
    scopeEpoch: row.message_visibility_epoch,
    sourceThreadBindingId: row.thread_binding_id,
    sourceAliasGeneration: row.alias_generation,
    sourceRevision: row.revision,
    retiredAt: row.retired_at,
    retiredReason: row.retired_reason,
    retirementEvidenceDigest: row.retirement_evidence_digest,
  }
  return {
    scopeId: row.ready_scope_id,
    scopeEpoch: row.message_visibility_epoch,
    sourceAliasGeneration: row.alias_generation,
    evidenceDigest: digestCanonicalJson(unsigned),
  }
}

export function readActionSurfaceInvalidation(context: CodexBindingContext, aliasId: string): {
  scopeId: string
  scopeEpoch: number
  aliasGeneration: number
  actionProjectionSequence: number
} | null {
  nonEmpty(aliasId, 'alias_identity_invalid')
  const row = context.db.prepare(`
      SELECT thread.ready_scope_id, thread.alias_generation,
             thread.action_projection_sequence, scope.message_visibility_epoch
        FROM codex_thread_bindings thread
        JOIN chat_conversations scope ON scope.id = thread.ready_scope_id
       WHERE thread.ready_conversation_alias = ?
       ORDER BY thread.alias_generation DESC LIMIT 1
    `).get<{
    ready_scope_id: string
    alias_generation: number
    action_projection_sequence: number
    message_visibility_epoch: number
  }>(aliasId)
  return row ? {
    scopeId: row.ready_scope_id,
    scopeEpoch: row.message_visibility_epoch,
    aliasGeneration: row.alias_generation,
    actionProjectionSequence: row.action_projection_sequence,
  } : null
}

export function readDriftedFreshStartAliases(context: CodexBindingContext, input: {
  runtimeManifestDigest: string
  protocolSchemaDigest: string
}): string[] {
  return context.db.prepare(`
      SELECT ready_conversation_alias FROM codex_thread_bindings
       WHERE retired_at IS NULL AND thread_materialization_kind IN ('legacy', 'fresh_start') AND codex_thread_id IS NULL
         AND (runtime_manifest_digest != ? OR protocol_schema_digest != ?)
       ORDER BY ready_conversation_alias
    `).all<{ ready_conversation_alias: string }>(
    input.runtimeManifestDigest, input.protocolSchemaDigest,
  ).map((row) => row.ready_conversation_alias)
}

export function readManualCompactionRoute(context: CodexBindingContext, input: {
  aliasId: string
  aliasGeneration: number
}): CodexManualCompactionRouteRead {
  nonEmpty(input.aliasId, 'alias_identity_invalid')
  safePositive(input.aliasGeneration, 'alias_generation_invalid')
  const row = readActiveThreadByAlias(context, input.aliasId)
  if (
    !row
    || row.alias_generation !== input.aliasGeneration
    || row.retired_at
    || row.continuation_blocked_at
    || !row.codex_thread_id
    || !row.codex_model
  ) throw new CodexBindingRepositoryError('manual_compaction_route_unavailable')
  const latestTurn = readLatestClosedTurnUpstreamRoute(context, row.thread_binding_id)
  if (!latestTurn) throw new CodexBindingRepositoryError('manual_compaction_route_unavailable')
  return {
    threadBindingId: row.thread_binding_id,
    aliasId: row.ready_conversation_alias,
    aliasGeneration: row.alias_generation,
    codexThreadId: row.codex_thread_id,
    codexModel: latestTurn.effective_codex_model,
    upstreamProfileSnapshotRef: latestTurn.effective_upstream_snapshot_ref,
    upstreamProfileSnapshotDigest: latestTurn.effective_upstream_snapshot_digest,
  }
}

export function readLifecycleOperation(context: CodexBindingContext, input: {
  aliasId: string
  aliasGeneration: number
}): CodexLifecycleOperationRead {
  nonEmpty(input.aliasId, 'alias_identity_invalid')
  safePositive(input.aliasGeneration, 'alias_generation_invalid')
  const thread = readActiveThreadByAlias(context, input.aliasId)
  if (!thread || thread.alias_generation !== input.aliasGeneration || thread.retired_at) {
    throw new CodexBindingRepositoryError('active_alias_generation_mismatch')
  }
  const turns = context.db.prepare(`
      SELECT turn.ready_run_id, turn.turn_start_reservation_released_at,
             turn.product_terminal_digest, turn.host_failure_product_terminal_digest,
             turn.interrupt_requested_at, turn.interrupt_ack_at, turn.lifecycle_action,
             turn.codex_turn_id, turn.turn_start_reconciled_at, turn.interrupt_state_unknown_at,
             turn.engine_terminal_recorded_at, turn.host_failure_kind, turn.host_failure_evidence_digest
        FROM codex_turn_bindings turn
       WHERE turn.thread_binding_id = ?
       ORDER BY turn.created_at ASC, turn.ready_run_id ASC
    `).all<TurnBindingRow>(thread.thread_binding_id)
  const fences = context.db.prepare(`
      SELECT operation_kind, owner_ready_run_id, owner_manual_compaction_id
        FROM codex_thread_dispatch_fences WHERE thread_binding_id = ?
    `).all<{
    operation_kind: 'product_turn' | 'manual_compaction'
    owner_ready_run_id: string | null
    owner_manual_compaction_id: string | null
  }>(thread.thread_binding_id)
  if (fences.length > 1) throw new CodexBindingRepositoryError('lifecycle_fence_invariant_broken')
  const fence = fences[0] || null
  const activeTurn = fence?.operation_kind === 'product_turn'
    ? turns.filter((turn) => turn.ready_run_id === fence.owner_ready_run_id)
    : []
  if (activeTurn.length > 1) throw new CodexBindingRepositoryError('lifecycle_owner_invariant_broken')
  if (fence?.operation_kind === 'product_turn' && activeTurn.length !== 1) {
    throw new CodexBindingRepositoryError('lifecycle_owner_missing')
  }
  const owner = activeTurn[0] || null
  const manual = context.db.prepare(`
      SELECT consumed_at, abandoned_at, abandoned_reconciled_at, unknown_at
        FROM codex_manual_compaction_bindings
       WHERE thread_binding_id = ? ORDER BY created_at DESC LIMIT 1
    `).get<{
    consumed_at: string | null
    abandoned_at: string | null
    abandoned_reconciled_at: string | null
    unknown_at: string | null
  }>(thread.thread_binding_id)
  const manualCompactionState: LifecycleOperationFacts['manualCompactionState'] = !manual
    ? 'none'
    : manual.consumed_at || (manual.abandoned_at && manual.abandoned_reconciled_at)
      ? 'consumed'
      : manual.abandoned_at || manual.unknown_at ? 'unknown' : 'pending'
  const allNativeThreadAttemptsSettled = turns.every((turn) => (
    turn.turn_start_reservation_released_at !== null
    && Boolean(turn.product_terminal_digest || turn.host_failure_product_terminal_digest)
  ))
  const legacyPrepared = context.db.prepare(`
      SELECT 1 AS present FROM codex_turn_bindings
       WHERE thread_binding_id = ?
         AND product_terminal_digest IS NULL
         AND host_failure_product_terminal_digest IS NULL
         AND (
           json_valid(ingress_json) = 0
           OR COALESCE(json_extract(ingress_json, '$.prepared.preparationContract'), '')
                != 'codex_product_run_e2'
         )
       LIMIT 1
    `).get<{ present: number }>(thread.thread_binding_id)
  return {
    identity: { aliasId: thread.ready_conversation_alias, aliasGeneration: thread.alias_generation },
    hasLegacyPreparedRun: legacyPrepared?.present === 1,
    activeReadyRunId: owner?.ready_run_id || null,
    activeManualCompactionId: fence?.operation_kind === 'manual_compaction'
      ? fence.owner_manual_compaction_id
      : null,
    latestReadyRunId: turns.at(-1)?.ready_run_id || null,
    interruptRequested: Boolean(owner?.interrupt_requested_at),
    interruptAcknowledged: Boolean(owner?.interrupt_ack_at),
    requestedAction: owner?.lifecycle_action || null,
    facts: {
      readyRunCreated: turns.length > 0,
      codexThreadId: thread.codex_thread_id,
      codexTurnId: owner?.codex_turn_id || null,
      activeFence: fence?.operation_kind || null,
      threadStartUnreconciled: Boolean(
        thread.thread_start_reservation_set_id
        && !thread.thread_start_reservation_released_at,
      ),
      turnStartUnreconciled: Boolean(
        owner
        && !owner.turn_start_reservation_released_at
        && !owner.turn_start_reconciled_at,
      ),
      productRunNonterminal: Boolean(
        owner && !owner.product_terminal_digest && !owner.host_failure_product_terminal_digest,
      ),
      interruptStateUnknown: Boolean(owner?.interrupt_state_unknown_at),
      engineTerminalRecorded: Boolean(owner?.engine_terminal_recorded_at
        && !owner.product_terminal_digest && !owner.host_failure_product_terminal_digest),
      readyCloseoutCommitted: Boolean(
        owner?.product_terminal_digest || owner?.host_failure_product_terminal_digest,
      ),
      readyTerminalWithoutNativeThread: !thread.codex_thread_id && turns.some((turn) => (
        Boolean(turn.product_terminal_digest || turn.host_failure_product_terminal_digest)
      )),
      allNativeThreadAttemptsSettled,
      hostFailureEvidenceComplete: Boolean(owner?.host_failure_kind && owner.host_failure_evidence_digest),
      hostFailureProductTerminalCommitted: Boolean(owner?.host_failure_product_terminal_digest),
      manualCompactionState,
    },
  }
}

export function readHeadActionFacts(context: CodexBindingContext, input: {
  aliasId: string
  aliasGeneration: number
  currentRuntimeManifestDigest: string
  currentProtocolSchemaDigest: string
  headContractBlocker?: CodexHeadActionBlocker | null
}): CodexHeadActionFacts {
  const thread = readActiveThreadByAlias(context, input.aliasId)
  if (!thread || thread.alias_generation !== input.aliasGeneration || thread.retired_at) {
    throw new CodexBindingRepositoryError('active_alias_generation_mismatch')
  }
  const lifecycle = context.self.readLifecycleOperation(input)
  const scope = context.db.prepare(`
      SELECT message_visibility_epoch FROM chat_conversations WHERE id = ? LIMIT 1
    `).get<{ message_visibility_epoch: number }>(thread.ready_scope_id)
  if (!scope || !Number.isSafeInteger(scope.message_visibility_epoch)
    || scope.message_visibility_epoch < 0) {
    throw new CodexBindingRepositoryError('scope_epoch_missing')
  }
  if (thread.thread_materialization_kind === 'native_fork') {
    context.self.readNativeForkMaterialization(thread.thread_binding_id)
  }
  const legacyPrepared = context.db.prepare(`
      SELECT 1 AS present FROM codex_turn_bindings
       WHERE thread_binding_id = ?
         AND product_terminal_digest IS NULL
         AND host_failure_product_terminal_digest IS NULL
         AND (
           json_valid(ingress_json) = 0
           OR COALESCE(json_extract(ingress_json, '$.prepared.preparationContract'), '')
                != 'codex_product_run_e2'
         )
       LIMIT 1
    `).get<{ present: number }>(thread.thread_binding_id)
  const structuredTail = context.self.readLiveUncommittedUserTail(thread.thread_binding_id)
    .filter((item): item is CodexUncommittedUserTailItem & {
      policy: 'resource_restatement_required' | 'task_restatement_required'
    } => item.policy !== 'untrusted_text_history')
    .map((item) => ({
      messageId: item.originUserMessageId,
      digest: item.inputDigest,
      policy: item.policy,
    }))
  return {
    scopeId: thread.ready_scope_id,
    scopeEpoch: scope.message_visibility_epoch,
    aliasId: thread.ready_conversation_alias,
    aliasGeneration: thread.alias_generation,
    threadBindingId: thread.thread_binding_id,
    headRevision: thread.revision,
    actionProjectionSequence: thread.action_projection_sequence,
    materializationKind: thread.thread_materialization_kind,
    materializationState: thread.materialization_state,
    codexThreadId: thread.codex_thread_id,
    continuationBlocked: thread.continuation_blocked_at !== null,
    activeProductFence: lifecycle.facts.activeFence === 'product_turn',
    manualCompactionState: lifecycle.facts.manualCompactionState,
    hasLegacyPreparedRun: legacyPrepared?.present === 1,
    headRuntimeManifestDigest: thread.runtime_manifest_digest,
    headProtocolSchemaDigest: thread.protocol_schema_digest,
    currentRuntimeManifestDigest: input.currentRuntimeManifestDigest,
    currentProtocolSchemaDigest: input.currentProtocolSchemaDigest,
    headContractBlocker: input.headContractBlocker,
    materializationIntentRef: thread.thread_start_request_id && thread.history_seed_digest
      ? { id: thread.thread_start_request_id, digest: thread.history_seed_digest }
      : null,
    uncommittedStructuredTail: structuredTail,
  }
}

export function readLatestLifecycleCloseout(context: CodexBindingContext, input: {
  aliasId: string
  aliasGeneration: number
  readyRunId?: string
}): CodexLifecycleCloseoutRead {
  nonEmpty(input.aliasId, 'alias_identity_invalid')
  safePositive(input.aliasGeneration, 'alias_generation_invalid')
  if (input.readyRunId !== undefined) nonEmpty(input.readyRunId, 'ready_run_id_invalid')
  const row = context.db.prepare(`
      SELECT turn.ready_run_id, turn.thread_binding_id,
             turn.codex_thread_id, turn.codex_turn_id, turn.product_terminal_digest,
             turn.host_failure_product_terminal_digest, turn.fence_release_revision,
             turn.engine_terminal_status,
             projection.status AS projection_status,
             thread.retired_reason
        FROM codex_turn_bindings turn
        JOIN codex_thread_bindings thread ON thread.thread_binding_id = turn.thread_binding_id
        JOIN task_projections projection
          ON projection.task_id = turn.ready_task_id AND projection.run_id = turn.ready_run_id
       WHERE thread.ready_conversation_alias = ? AND thread.alias_generation = ?
         AND (? IS NULL OR turn.ready_run_id = ?)
         AND (turn.product_terminal_digest IS NOT NULL
           OR turn.host_failure_product_terminal_digest IS NOT NULL)
       ORDER BY COALESCE(turn.product_closeout_at, turn.host_failure_closeout_at) DESC
       LIMIT 1
    `).get<{
    ready_run_id: string
    thread_binding_id: string
    codex_thread_id: string | null
    codex_turn_id: string | null
    product_terminal_digest: string | null
    host_failure_product_terminal_digest: string | null
    fence_release_revision: number | null
    engine_terminal_status: 'completed' | 'interrupted' | 'failed' | null
    projection_status: string
    retired_reason: string | null
  }>(
    input.aliasId,
    input.aliasGeneration,
    input.readyRunId ?? null,
    input.readyRunId ?? null,
  )
  if (!row?.codex_thread_id || !row.codex_turn_id) {
    throw new CodexBindingRepositoryError('lifecycle_closeout_readback_missing')
  }
  const ownerFence = context.db.prepare(`
      SELECT 1 AS present FROM codex_thread_dispatch_fences
       WHERE thread_binding_id = ? AND operation_kind = 'product_turn'
         AND owner_ready_run_id = ? LIMIT 1
    `).get<{ present: number }>(row.thread_binding_id, row.ready_run_id)
  const productTerminal = row.projection_status === 'completed'
    ? 'completed' as const
    : row.projection_status === 'killed'
      ? 'interrupted' as const
      : row.projection_status === 'failed'
        ? 'failed' as const
        : null
  const terminal = row.retired_reason === 'publication_diverged'
    ? productTerminal
    : row.engine_terminal_status || productTerminal
  const closeoutDigest = row.product_terminal_digest || row.host_failure_product_terminal_digest
  if (!terminal || !closeoutDigest || ownerFence
    || row.fence_release_revision === null) {
    throw new CodexBindingRepositoryError('lifecycle_closeout_incomplete')
  }
  return {
    aliasId: input.aliasId,
    aliasGeneration: input.aliasGeneration,
    codexThreadId: row.codex_thread_id,
    codexTurnId: row.codex_turn_id,
    terminal,
    closeoutDigest,
    fenceReleaseRevision: row.fence_release_revision,
  }
}

export function readProductTurnPresentation(
  context: CodexBindingContext,
  readyRunId: string,
  currentEnvironment?: {
    requestedWorkbenchMode: 'browser' | 'document' | 'rss' | 'calendar'
    trustedWorkbenchMode: 'browser' | 'document' | 'rss' | 'calendar'
  },
): ProductTurnReceipt {
  return readProductTurnPresentationFromDb(context.db, readyRunId, currentEnvironment,
    (runId) => context.self.readProductTurnActionContext(runId, currentEnvironment))
}

export function readProductTurnPresentations(
  context: CodexBindingContext,
  readyRunIds: readonly string[],
  currentEnvironment?: {
    requestedWorkbenchMode: 'browser' | 'document' | 'rss' | 'calendar'
    trustedWorkbenchMode: 'browser' | 'document' | 'rss' | 'calendar'
  },
): ProductTurnReceipt[] {
  // One DB read transaction, one current-head read per head + trusted mode.
  // This map never survives the batch or participates in action admission.
  const heads = new Map<string, ProductTurnHeadReadSnapshot>()
  return readProductTurnPresentationsFromDb(
    context.db,
    readyRunIds,
    currentEnvironment,
    (runId) => context.self.readProductTurnActionContext(runId, currentEnvironment, heads),
  )
}

export function readProductTurnActionContext(
  context: CodexBindingContext,
  readyRunId: string,
  currentEnvironment?: {
    requestedWorkbenchMode: 'browser' | 'document' | 'rss' | 'calendar'
    trustedWorkbenchMode: 'browser' | 'document' | 'rss' | 'calendar'
  },
  heads = new Map<string, ProductTurnHeadReadSnapshot>(),
): ProductTurnActionContext | null {
  const owner = requireTurn(context, readyRunId)
  const ownerThread = requireThread(context, owner.thread_binding_id)
  const head = readActiveThreadByAlias(context, ownerThread.ready_conversation_alias)
  if (!head || codexThreadPredatesMaterializationRecords(head.thread_materialization_kind)) return null
  const prepared = context.self.readProductTurnRuntime(readyRunId).prepared
  const rootRef = prepared.ingress.modelVisibleRootOriginRef
  const source = prepared.ingress.attemptKind === 'explicit_retry'
    ? context.self.readProductTurnRuntime(rootRef!.sourceReadyRunId).prepared : prepared
  if (rootRef && (source.ingress.attemptKind !== 'user_ingress'
    || source.readyToolHostIdentity.scopeId !== ownerThread.ready_scope_id
    || digestCanonicalJson(source) !== rootRef.sourceIngressContractDigest
    || source.ingress.canonicalCurrentInputRef.messageId !== rootRef.originUserMessageId
    || digestCodexUserInput(source.ingress.canonicalCurrentInputRef.input) !== rootRef.inputDigest)) {
    throw new CodexBindingRepositoryError('retry_root_origin_invalid')
  }
  const workbenchMode = currentEnvironment?.trustedWorkbenchMode
    ?? prepared.sourceTrustedEnvironmentRef.workbenchMode
  const headKey = JSON.stringify([head.thread_binding_id, workbenchMode])
  let snapshot = heads.get(headKey)
  if (!snapshot) {
    const headFacts = context.self.readHeadActionFacts({
      aliasId: head.ready_conversation_alias,
      aliasGeneration: head.alias_generation,
      currentRuntimeManifestDigest: context.currentContract?.runtimeManifestDigest || head.runtime_manifest_digest,
      currentProtocolSchemaDigest: context.currentContract?.protocolSchemaDigest || head.protocol_schema_digest,
    })
    const headContractBlocker = context.currentContract?.resolveHeadContractBlocker?.({
      aliasId: head.ready_conversation_alias,
      aliasGeneration: head.alias_generation,
      scopeEpoch: headFacts.scopeEpoch,
      workbenchMode,
      threadBindingId: head.thread_binding_id,
      codexThreadId: head.codex_thread_id,
      materializationKind: head.thread_materialization_kind,
    })
    const acceptedHead = context.self.readAcceptedNativePrefixHead(head.thread_binding_id)
    snapshot = {
      headFacts: headContractBlocker === undefined ? headFacts : { ...headFacts, headContractBlocker },
      liveTail: context.self.readLiveUncommittedUserTail(head.thread_binding_id),
      hasHeadProduct: Boolean(context.db.prepare(`SELECT 1 AS present FROM codex_turn_bindings
          WHERE thread_binding_id = ? LIMIT 1`).get(head.thread_binding_id)),
      compacted: acceptedHead
        ? readNativeCoverage(context.db, acceptedHead.coverageReceiptRef.receiptId).compacted
        : new Map(),
    }
    heads.set(headKey, snapshot)
  }
  const root = source.ingress.canonicalCurrentInputRef
  const sourceRootCompacted = snapshot.compacted.get(root.messageId) === digestCodexUserInput(root.input)
  const tailPlan = resolveExplicitRetryTailPlan(snapshot.liveTail, {
    originUserMessageId: root.messageId, inputDigest: digestCodexUserInput(root.input),
  })
  return {
    headFacts: snapshot.headFacts,
    sourcePrepared: source,
    sourceRootCompacted,
    exactLiveRootOnDirectSuccessor: head.history_source_thread_binding_id === owner.thread_binding_id
      && head.history_source_terminal_facts_digest === owner.terminal_facts_digest
      && head.alias_generation === ownerThread.alias_generation + 1 && !snapshot.hasHeadProduct
      && !context.self.readProductTurnSuccessorId(readyRunId)
      && tailPlan.kind === 'eligible',
  }
}

export function readLifecycleActionCloseout(context: CodexBindingContext, readyRunId: string): CodexLifecycleActionCloseoutRead {
  nonEmpty(readyRunId, 'ready_run_id_invalid')
  const turn = requireTurn(context, readyRunId)
  const thread = requireThread(context, turn.thread_binding_id)
  const lifecycle = context.self.readProductLifecycleAction(readyRunId)
  if (!lifecycle || !turn.codex_thread_id || !turn.codex_turn_id
    || !turn.engine_terminal_status || !turn.product_terminal_digest
    || !turn.product_closeout_at || turn.fence_release_revision === null) {
    throw new CodexBindingRepositoryError('lifecycle_action_closeout_readback_missing')
  }
  const facts = turn.terminal_facts_json
    ? JSON.parse(turn.terminal_facts_json) as CodexTerminalFacts
    : null
  if (lifecycle.lifecycleAction === 'stop') {
    if (!facts || !['continuation_safe', 'diverged', 'unknown_reset_required']
      .includes(facts.history.kind)) {
      throw new CodexBindingRepositoryError('lifecycle_action_closeout_readback_mismatch')
    }
    if (facts.history.kind === 'continuation_safe'
      && (thread.retired_at !== null || thread.continuation_blocked_at !== null)) {
      throw new CodexBindingRepositoryError('lifecycle_action_closeout_readback_mismatch')
    }
    if (facts.history.kind === 'diverged'
      && (thread.retired_at !== turn.product_closeout_at
        || thread.retired_reason !== 'publication_diverged')) {
      throw new CodexBindingRepositoryError('lifecycle_action_closeout_readback_mismatch')
    }
    if (facts.history.kind === 'unknown_reset_required'
      && (thread.retired_at !== null || thread.continuation_blocked_at !== turn.product_closeout_at)) {
      throw new CodexBindingRepositoryError('lifecycle_action_closeout_readback_mismatch')
    }
  } else if (thread.retired_at !== turn.product_closeout_at
    || thread.retirement_evidence_digest !== lifecycle.lifecycleActionEvidenceDigest
    || thread.continuation_blocked_at !== null
    || thread.retired_reason !== (lifecycle.lifecycleAction === 'reset' ? 'user_reset' : 'closed')) {
    throw new CodexBindingRepositoryError('lifecycle_action_closeout_readback_mismatch')
  }
  const successor = lifecycle.lifecycleAction === 'reset'
    || (lifecycle.lifecycleAction === 'stop' && facts?.history.kind === 'diverged')
    ? context.db.prepare(`
          SELECT thread_binding_id, alias_generation FROM codex_thread_bindings
           WHERE ready_conversation_alias = ? AND alias_generation = ? LIMIT 1
        `).get<{ thread_binding_id: string; alias_generation: number }>(
        thread.ready_conversation_alias,
        thread.alias_generation + 1,
      )
    : null
  if ((lifecycle.lifecycleAction === 'reset'
    || (lifecycle.lifecycleAction === 'stop' && facts?.history.kind === 'diverged'))
    && !successor) {
    throw new CodexBindingRepositoryError('lifecycle_action_reset_successor_missing')
  }
  const newGeneration = successor?.alias_generation ?? null
  const newThreadBindingId = successor?.thread_binding_id ?? null
  const retirementTransactionDigest = lifecycle.lifecycleAction === 'stop'
    ? null
    : codexLifecycleActionRetirementDigest({
        action: lifecycle.lifecycleAction,
        readyRunId,
        aliasId: thread.ready_conversation_alias,
        retiredGeneration: thread.alias_generation,
        threadBindingId: thread.thread_binding_id,
        lifecycleActionEvidenceDigest: lifecycle.lifecycleActionEvidenceDigest,
        productTerminalDigest: turn.product_terminal_digest,
        closeoutAt: turn.product_closeout_at,
        newGeneration,
        newThreadBindingId,
      })
  const archiveIntent = lifecycle.lifecycleAction === 'stop'
    ? null
    : requireThreadArchiveIntent(context, {
        threadBindingId: thread.thread_binding_id,
        sourceKind: lifecycle.lifecycleAction === 'close'
          ? 'engine_terminal_close' : 'engine_terminal_reset',
        readyRunId,
        retirementTransactionDigest: retirementTransactionDigest as string,
      })
  const scopeClosure = lifecycle.lifecycleAction === 'close'
    ? readCodexClosedConversationScope(context.db, thread.ready_scope_id)
    : null
  if (lifecycle.lifecycleAction === 'close' && (!scopeClosure
    || scopeClosure.closedAt !== turn.product_closeout_at
    || scopeClosure.closeEvidenceDigest !== retirementTransactionDigest)) {
    throw new CodexBindingRepositoryError('lifecycle_action_scope_closeout_readback_missing')
  }
  return {
    action: lifecycle.lifecycleAction,
    readyRunId,
    aliasId: thread.ready_conversation_alias,
    aliasGeneration: thread.alias_generation,
    codexThreadId: turn.codex_thread_id,
    codexTurnId: turn.codex_turn_id,
    terminal: turn.engine_terminal_status,
    closeoutDigest: turn.product_terminal_digest,
    fenceReleaseRevision: turn.fence_release_revision,
    lifecycleActionEvidenceDigest: lifecycle.lifecycleActionEvidenceDigest,
    retiredGeneration: thread.retired_at === null ? null : thread.alias_generation,
    retirementTransactionDigest,
    archiveIntentDigest: archiveIntent?.intentDigest ?? null,
    scopeClosureEvidenceDigest: scopeClosure?.closeEvidenceDigest ?? null,
    newGeneration,
    newThreadBindingId,
  }
}
