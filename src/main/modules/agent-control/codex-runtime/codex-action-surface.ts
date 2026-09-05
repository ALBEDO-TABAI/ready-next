import type {
  CodexActionGate,
  CodexHeadActionProjection,
} from '../../../../shared/ipc-contracts/agent-runtime'
import { digestCanonicalJson } from './codex-model-gateway-contract'

export const CODEX_HEAD_ACTION_BLOCKER_PRECEDENCE = [
  'closed',
  'head_contract_drift',
  'runtime_unverified',
  'runtime_unsupported',
  'model_changed',
  'thread_config_changed',
  'cwd_unavailable',
  'cwd_changed',
  'instruction_contract_changed',
  'native_tool_surface_extension_required',
  'native_tool_definition_changed',
  'ready_tool_execution_contract_changed',
  'current_contract_read_failed',
  'legacy_prepared_contract',
  'terminal_history_unknown',
  'history_outcome_unknown',
  'history_materializing',
  'manual_compaction_unknown',
  'manual_compaction_pending',
  'thread_busy',
] as const

export type CodexHeadActionBlocker = typeof CODEX_HEAD_ACTION_BLOCKER_PRECEDENCE[number]

export type CodexHeadActionFacts = {
  scopeId: string
  scopeEpoch: number
  aliasId: string
  aliasGeneration: number
  threadBindingId: string
  headRevision: number
  actionProjectionSequence: number
  materializationKind: 'legacy' | 'fresh_start' | 'native_fork' | 'fresh_root_with_tail'
  materializationState: 'pending' | 'confirmed' | 'unknown' | 'proven_absent' | 'abandoned'
  codexThreadId: string | null
  continuationBlocked: boolean
  activeProductFence: boolean
  manualCompactionState: 'none' | 'pending' | 'unknown' | 'consumed'
  hasLegacyPreparedRun: boolean
  headRuntimeManifestDigest: string
  headProtocolSchemaDigest: string
  currentRuntimeManifestDigest: string
  currentProtocolSchemaDigest: string
  headContractBlocker?: CodexHeadActionBlocker | null
  materializationIntentRef?: { id: string; digest: string } | null
  uncommittedStructuredTail?: Array<{
    messageId: string
    digest: string
    policy: 'resource_restatement_required' | 'task_restatement_required'
  }>
}

function orderedBlockers(values: Iterable<CodexHeadActionBlocker>): CodexHeadActionBlocker[] {
  const selected = new Set(values)
  return CODEX_HEAD_ACTION_BLOCKER_PRECEDENCE.filter((value) => selected.has(value))
}

export function projectCodexHeadActionProjection(
  facts: CodexHeadActionFacts,
): CodexHeadActionProjection {
  const blockers: CodexHeadActionBlocker[] = []
  if (facts.headContractBlocker !== undefined) {
    if (facts.headContractBlocker) blockers.push(facts.headContractBlocker)
  } else if (facts.headRuntimeManifestDigest !== facts.currentRuntimeManifestDigest
    || facts.headProtocolSchemaDigest !== facts.currentProtocolSchemaDigest) blockers.push('head_contract_drift')
  if (facts.hasLegacyPreparedRun) blockers.push('legacy_prepared_contract')
  if (facts.continuationBlocked) blockers.push('terminal_history_unknown')
  if (facts.materializationState === 'unknown'
    || facts.materializationState === 'proven_absent'
    || facts.materializationState === 'abandoned') blockers.push('history_outcome_unknown')
  if (facts.materializationKind === 'native_fork' && facts.materializationState === 'pending') {
    blockers.push('history_materializing')
  }
  if (facts.manualCompactionState === 'unknown') blockers.push('manual_compaction_unknown')
  if (facts.manualCompactionState === 'pending') blockers.push('manual_compaction_pending')
  if (facts.activeProductFence) blockers.push('thread_busy')
  const canonicalBlockers = orderedBlockers(blockers)
  const structuredTail = facts.uncommittedStructuredTail || []
  const omittedItemCount = structuredTail.length
  const resourceReattachItemCount = structuredTail.filter(
    (item) => item.policy === 'resource_restatement_required',
  ).length

  const historyState: CodexHeadActionProjection['historyState'] = facts.continuationBlocked
    ? 'terminal_unknown'
    : facts.materializationKind === 'legacy'
      ? 'legacy_context_boundary'
      : facts.materializationState === 'unknown'
          || facts.materializationState === 'proven_absent'
          || facts.materializationState === 'abandoned'
        ? 'materialization_unknown'
        : facts.materializationKind === 'native_fork' && facts.materializationState === 'pending'
          ? 'materializing'
          : facts.materializationKind === 'fresh_root_with_tail'
              || (facts.materializationKind === 'fresh_start' && !facts.codexThreadId)
            ? 'fresh_root_ready_for_ingress'
            : facts.materializationKind === 'native_fork'
              ? 'ready'
              : 'same_thread_ready'
  const gate: CodexActionGate = {
    availability: canonicalBlockers.length === 0 ? 'ready' : 'blocked',
    blockers: canonicalBlockers,
    consequence: omittedItemCount === 0
      ? null
      : {
          kind: 'supersedes_uncommitted_structured_tail',
          omittedItemCount,
          resourceReattachItemCount,
          itemsDigest: digestCanonicalJson(structuredTail),
        },
  }
  const unsigned = {
    kind: 'scope_head' as const,
    scopeId: facts.scopeId,
    ownerRunId: null,
    historyState,
    actionHeadIdentity: {
      aliasId: facts.aliasId,
      aliasGeneration: facts.aliasGeneration,
      threadBindingId: facts.threadBindingId,
      headRevision: facts.headRevision,
    },
    closedByLifecycleRef: null,
    actions: { send_new_message: gate },
    actionProjectionVersion: {
      scopeEpoch: facts.scopeEpoch,
      headGeneration: facts.aliasGeneration,
      actionProjectionSequence: facts.actionProjectionSequence,
    },
  }
  return { ...unsigned, evidenceDigest: digestCanonicalJson(unsigned) }
}

export function assertCodexHeadActionProjection(value: CodexHeadActionProjection): void {
  const blockers = value.actions.send_new_message.blockers
  const consequence = value.actions.send_new_message.consequence
  const blockerPositions = blockers.map((blocker) => (
    CODEX_HEAD_ACTION_BLOCKER_PRECEDENCE.indexOf(blocker as CodexHeadActionBlocker)
  ))
  if (new Set(blockers).size !== blockers.length
    || blockerPositions.some((position, index) => position < 0
      || (index > 0 && position < blockerPositions[index - 1]))
    || (value.actions.send_new_message.availability === 'ready') !== (blockers.length === 0)
    || (consequence !== null && (
      consequence.omittedItemCount < 1
      || consequence.resourceReattachItemCount < 0
      || consequence.resourceReattachItemCount > consequence.omittedItemCount
      || !/^[a-f0-9]{64}$/.test(consequence.itemsDigest)
    ))
    || value.evidenceDigest !== digestCanonicalJson({
      kind: value.kind,
      scopeId: value.scopeId,
      ownerRunId: value.ownerRunId,
      historyState: value.historyState,
      actionHeadIdentity: value.actionHeadIdentity,
      closedByLifecycleRef: value.closedByLifecycleRef,
      actions: value.actions,
      actionProjectionVersion: value.actionProjectionVersion,
    })) {
    throw new Error('codex_head_action_projection_invalid')
  }
}
