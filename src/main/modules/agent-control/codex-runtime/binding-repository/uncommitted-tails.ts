import { parseObjectStrict } from '../../../repositories/browser-workflow-codec'
import { CodexBindingRepositoryError } from '../codex-binding-error'
import { classifyUncommittedOriginPolicy, formalModelInputOrigins, resolveLiveUncommittedUserTail } from '../codex-history-continuity-policy'
import { digestCanonicalJson } from '../codex-model-gateway-contract'
import { readNativeCoverage } from '../codex-native-coverage-reader'
import { isPreparedCodexProductRun, type PreparedCodexProductRun } from '../codex-product-run-preparer'
import { assertCodexTerminalFacts, type CodexTerminalFacts } from '../codex-terminal-facts'
import { digestCodexUserInput, isCodexUserInput, type CodexUserInput } from '../codex-user-input'
import type { CodexBindingContext } from './context'
import { requireThread, requireTurn } from './core'
import { assertNativeTerminalCandidate, isRecord } from './shared'
import type { CodexUncommittedUserTailItem, NativeTerminalCandidate, ThreadBindingRow, TurnBindingRow } from './types'
import { codexThreadPredatesMaterializationRecords, codexThreadStartsLineage } from '../codex-thread-materialization'

// User input the native history has not accepted yet, and its delivery audit.

export function readUncommittedUserTail(context: CodexBindingContext, threadBindingId: string): CodexUncommittedUserTailItem[] {
  const thread = requireThread(context, threadBindingId)
  if (thread.thread_materialization_kind !== 'fresh_root_with_tail'
    && thread.thread_materialization_kind !== 'native_fork') return []
  if (!thread.uncommitted_user_tail_json || !thread.uncommitted_user_tail_digest) {
    throw new CodexBindingRepositoryError('uncommitted_user_tail_missing')
  }
  let parsed: unknown
  try { parsed = JSON.parse(thread.uncommitted_user_tail_json) }
  catch { throw new CodexBindingRepositoryError('uncommitted_user_tail_invalid') }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 8
    || parsed.some((entry) => !isRecord(entry)
      || typeof entry.originUserMessageId !== 'string'
      || !entry.originUserMessageId.trim()
      || !['untrusted_text_history', 'resource_restatement_required', 'task_restatement_required']
        .includes(String(entry.policy))
      || !Array.isArray(entry.input)
      || entry.input.length < 1
      || entry.input.some((item) => !isCodexUserInput(item))
      || (entry.policy === 'untrusted_text_history'
        && entry.input.some((item) => item.type !== 'text'))
      || entry.inputDigest !== digestCodexUserInput(entry.input as CodexUserInput[]))) {
    throw new CodexBindingRepositoryError('uncommitted_user_tail_invalid')
  }
  if (digestCanonicalJson(parsed) !== thread.uncommitted_user_tail_digest) {
    throw new CodexBindingRepositoryError('uncommitted_user_tail_digest_mismatch')
  }
  const sourceTurn = context.db.prepare(`
      SELECT ready_run_id, ingress_admitted_digest
        FROM codex_turn_bindings
       WHERE thread_binding_id = ? AND terminal_facts_digest = ?
       LIMIT 1
    `).get<{ ready_run_id: string; ingress_admitted_digest: string }>(
    thread.history_source_thread_binding_id,
    thread.history_source_terminal_facts_digest,
  )
  if (!sourceTurn || !thread.history_seed_digest) {
    throw new CodexBindingRepositoryError('history_seed_source_missing')
  }
  const expectedHistorySeedDigest = thread.thread_materialization_kind === 'fresh_root_with_tail'
    ? digestCanonicalJson({
        contract: 'codex_fresh_root_with_tail_seed_v1',
        sourceThreadBindingId: thread.history_source_thread_binding_id,
        sourceTerminalFactsDigest: thread.history_source_terminal_facts_digest,
        tailDigest: thread.uncommitted_user_tail_digest,
      })
    : digestCanonicalJson({
        sourceThreadBindingId: thread.history_source_thread_binding_id,
        sourceTerminalFactsDigest: thread.history_source_terminal_facts_digest,
        acceptedProductBoundaryReadyRunId: thread.accepted_product_boundary_ready_run_id,
        acceptedNativeCoverageReceiptRef: {
          receiptId: thread.source_accepted_native_coverage_receipt_id,
          digest: thread.source_accepted_native_coverage_receipt_digest,
        },
        forkAcceptedThroughCodexTurnId: thread.fork_accepted_through_codex_turn_id,
        divergentIngressDigest: sourceTurn.ingress_admitted_digest,
        uncommittedUserTailDigest: thread.uncommitted_user_tail_digest,
      })
  if (thread.history_seed_digest !== expectedHistorySeedDigest) {
    throw new CodexBindingRepositoryError('history_seed_digest_mismatch')
  }
  return parsed as CodexUncommittedUserTailItem[]
}

export function readLiveUncommittedUserTail(context: CodexBindingContext, threadBindingId: string): CodexUncommittedUserTailItem[] {
  return readUncommittedOriginTails(context, threadBindingId).currentDeliveryTail
}

export function readHandoffUncommittedUserTail(context: CodexBindingContext, threadBindingId: string): CodexUncommittedUserTailItem[] {
  const tail = readUncommittedOriginTails(context, threadBindingId).handoffTail
  if (tail.length > 8) throw new CodexBindingRepositoryError('uncommitted_user_tail_budget_exceeded')
  return tail
}

export function readUncommittedOriginTails(context: CodexBindingContext, threadBindingId: string, closingReadyRunId?: string): ReturnType<typeof resolveLiveUncommittedUserTail> {
  const lineage = readHistoryBindingLineage(context, threadBindingId)
  if (codexThreadPredatesMaterializationRecords(lineage[0].thread_materialization_kind)) {
    if (lineage.length > 1) throw new CodexBindingRepositoryError('history_binding_lineage_invalid')
    return { handoffTail: [], currentDeliveryTail: [] }
  }
  const head = context.self.readAcceptedNativePrefixHead(threadBindingId)
  const covered = head
    ? readNativeCoverage(context.db, head.coverageReceiptRef.receiptId).covered
    : new Map<string, string>()
  const origins: CodexUncommittedUserTailItem[] = []
  const retainedInCurrentNative = new Map<string, string>()
  const superseded: Array<{ originUserMessageId: string; inputDigest: string; policy: string }> = []
  for (const binding of lineage) {
    const turns = context.db.prepare(`
        SELECT turn.*,
          (SELECT COUNT(*) FROM codex_tool_call_admissions tool WHERE tool.ready_run_id = turn.ready_run_id) AS origin_tool_count,
          (SELECT COUNT(*) FROM pending_confirmations confirmation WHERE confirmation.run_id = turn.ready_run_id)
            + (SELECT COUNT(*) FROM chat_messages interaction
               WHERE interaction.conversation_id = ? AND interaction.role = 'agent_card'
                 AND (json_extract(interaction.meta_json, '$.askUserQuestions.requestId') = turn.ready_run_id
                   OR json_extract(interaction.meta_json, '$.askUserQuestions.codexRunIdentity.readyRunId') = turn.ready_run_id)) AS origin_interaction_count
        FROM codex_turn_bindings turn WHERE turn.thread_binding_id = ? ORDER BY turn.rowid ASC
      `).all<TurnBindingRow & { origin_tool_count: number; origin_interaction_count: number }>(binding.ready_scope_id, binding.thread_binding_id)
    for (const turn of turns) {
      const parsed = parseObjectStrict<{ prepared?: unknown }>(
        turn.ingress_json, 'uncommitted_user_tail_ingress_json',
      )
      if (!isPreparedCodexProductRun(parsed.prepared)) {
        throw new CodexBindingRepositoryError('uncommitted_user_tail_ingress_invalid')
      }
      const prepared = parsed.prepared
      if (prepared.ingress.attemptKind === 'user_ingress') {
        const items = prepared.ingress.supersededUncommittedItems!
        const admission = prepared.ingress.actionAdmissionRef
        if (items.length > 0 && (!admission
          || admission.actionHeadIdentity.threadBindingId !== binding.thread_binding_id
          || admission.actionHeadIdentity.aliasGeneration !== binding.alias_generation
          || admission.actionProjectionVersion.actionProjectionSequence > binding.action_projection_sequence)) {
          throw new CodexBindingRepositoryError('uncommitted_user_tail_supersession_owner_invalid')
        }
        superseded.push(...items)
      }
      // An admitted, still-running input is not an uncommitted predecessor. Its
      // ordinary supersession is nevertheless already an authoritative admission.
      if (!turn.product_closeout_at && !turn.host_failure_product_terminal_digest
        && turn.ready_run_id !== closingReadyRunId) continue
      const facts = turn.terminal_facts_json ? JSON.parse(turn.terminal_facts_json) as CodexTerminalFacts : null
      if (facts) assertCodexTerminalFacts(facts)
      if (binding.thread_binding_id === threadBindingId && facts?.history.kind === 'continuation_safe') {
        for (const origin of formalModelInputOrigins(prepared)) {
          retainedInCurrentNative.set(origin.messageId, origin.digest)
        }
      }
      const current = prepared.ingress.canonicalCurrentInputRef
      const currentDigest = digestCodexUserInput(current.input)
      if (covered.get(current.messageId) === currentDigest) continue
      const candidate = turn.engine_terminal_candidate_json
        ? JSON.parse(turn.engine_terminal_candidate_json) as NativeTerminalCandidate : null
      if (candidate) assertNativeTerminalCandidate(candidate)
      origins.push({
        originUserMessageId: current.messageId,
        input: current.input,
        inputDigest: currentDigest,
        policy: classifyUncommittedOriginPolicy({
          prepared,
          executionEvidenceComplete: Boolean(candidate && facts),
          toolCount: Math.max(candidate?.usedToolCalls.length || 0, turn.origin_tool_count),
          actionCount: candidate?.actionReceiptRefs.length || 0,
          interactionCount: Math.max(candidate?.interactionState ? 1 : 0, turn.origin_interaction_count),
          effectState: facts?.effect.state || 'indeterminate',
        }),
      })
    }
  }
  return resolveLiveUncommittedUserTail({ origins, covered, retainedInCurrentNative, superseded })
}

export function readHistoryBindingLineage(context: CodexBindingContext, threadBindingId: string): ThreadBindingRow[] {
  const lineage: ThreadBindingRow[] = []
  let binding = requireThread(context, threadBindingId)
  while (true) {
    if (lineage.some((prior) => prior.thread_binding_id === binding.thread_binding_id)) {
      throw new CodexBindingRepositoryError('history_binding_lineage_cycle')
    }
    lineage.unshift(binding)
    if (codexThreadStartsLineage(binding.thread_materialization_kind)) break
    context.self.readUncommittedUserTail(binding.thread_binding_id)
    const source = requireThread(context, binding.history_source_thread_binding_id as string)
    if (source.ready_conversation_alias !== binding.ready_conversation_alias
      || source.ready_scope_id !== binding.ready_scope_id
      || source.alias_generation + 1 !== binding.alias_generation
      || source.retired_reason !== 'publication_diverged') {
      throw new CodexBindingRepositoryError('history_binding_lineage_invalid')
    }
    binding = source
  }
  return lineage
}

export function readUncommittedTailDeliveryAudit(context: CodexBindingContext, readyRunId: string): {
  readyRunId: string
  state: 'accepted' | 'unknown'
  turnContractDigest: string
  additionalContextDigest: string
  items: Array<{
    originUserMessageId: string
    inputDigest: string
    assignment: 'deliver_untrusted_history' | 'replace_with_explicit_retry' | 'omit_from_current_run'
    disposition: 'additional_context' | 'current_input' | 'superseded' | 'unknown'
  }>
  auditDigest: string
} {
  const turn = requireTurn(context, readyRunId)
  let prepared: PreparedCodexProductRun
  try {
    const receipt = JSON.parse(turn.ingress_json || '') as unknown
    if (!isRecord(receipt) || !isPreparedCodexProductRun(receipt.prepared)) {
      throw new Error('invalid')
    }
    prepared = receipt.prepared
  } catch {
    throw new CodexBindingRepositoryError('delivery_audit_ingress_invalid')
  }
  const assignments = prepared.ingress.uncommittedTailAssignments || []
  const accepted = turn.turn_start_child_write_confirmed_at !== null
    && turn.turn_start_child_write_digest !== null
    && turn.turn_start_child_write_digest === turn.turn_start_request_digest
    && turn.turn_start_reconciled_at !== null
    && turn.turn_start_reconciliation_evidence_digest !== null
    && turn.codex_turn_id !== null
  const items = assignments.map((assignment) => {
    let disposition: 'additional_context' | 'current_input' | 'superseded' | 'unknown' = 'unknown'
    if (assignment.plan === 'omit_from_current_run') {
      const superseded = (prepared.ingress.supersededUncommittedItems || []).some((item) => (
        item.originUserMessageId === assignment.originUserMessageId
        && item.inputDigest === assignment.inputDigest
      ))
      disposition = superseded ? 'superseded' : 'unknown'
    } else if (accepted) {
      disposition = assignment.plan === 'replace_with_explicit_retry'
        ? 'current_input'
        : 'additional_context'
    }
    return {
      originUserMessageId: assignment.originUserMessageId,
      inputDigest: assignment.inputDigest,
      assignment: assignment.plan,
      disposition,
    }
  })
  const base = {
    readyRunId,
    state: accepted || (items.length > 0
      && items.every((item) => item.disposition === 'superseded'))
      ? 'accepted' as const
      : 'unknown' as const,
    turnContractDigest: turn.turn_contract_digest,
    additionalContextDigest: turn.additional_context_digest,
    items,
  }
  return { ...base, auditDigest: digestCanonicalJson(base) }
}
