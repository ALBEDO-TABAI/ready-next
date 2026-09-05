import type {
  LifecycleActionBlockingReason,
  LifecycleActionGate,
  LifecycleActionRequestRef,
  LifecycleOperationProjection,
  LifecycleOperationProjectionV2,
} from '../../../../shared/ipc-contracts/agent-lifecycle-snapshot'
import type { CodexHeadActionProjection } from '../../../../shared/ipc-contracts/agent-runtime'
import { digestCanonicalJson } from './codex-model-gateway-contract'

export const LIFECYCLE_ACTION_BLOCKER_PRECEDENCE = [
  'head_contract_drift',
  'runtime_unsupported',
  'runtime_unverified',
  'legacy_prepared_contract',
  'history_outcome_unknown',
  'history_materializing',
  'manual_compaction_unknown',
  'manual_compaction_pending',
  'interrupt_state_unknown',
  'thread_busy',
  'legacy_context_boundary',
  'no_active_operation',
] as const satisfies readonly LifecycleActionBlockingReason[]

type Action = keyof LifecycleOperationProjectionV2['actions']

export type CodexLifecycleActionSurfaceFacts = {
  base: LifecycleOperationProjection
  head: CodexHeadActionProjection
  scopeEpoch: number
  threadBindingId: string
  headRevision: number
  materializationIntentRef: { id: string; digest: string } | null
  manualCompactionRuntimeBlocker?: 'runtime_unverified' | 'runtime_unsupported' | null
}

function orderedBlockers(
  blockers: Iterable<LifecycleActionBlockingReason>,
): LifecycleActionBlockingReason[] {
  const selected = new Set(blockers)
  return LIFECYCLE_ACTION_BLOCKER_PRECEDENCE.filter((reason) => selected.has(reason))
}

function requestRef(input: CodexLifecycleActionSurfaceFacts, action: Action): LifecycleActionRequestRef {
  const shared = {
    action,
    aliasId: input.base.identity.aliasId,
    scopeId: input.head.scopeId,
    scopeEpoch: input.scopeEpoch,
    aliasGeneration: input.base.identity.aliasGeneration,
    lifecycleEvidenceDigest: input.base.evidenceDigest,
    headProjectionDigest: input.head.evidenceDigest,
  }
  const runOwned = action !== 'manual_compact' && input.base.activeReadyRunId
  const unsigned = runOwned
    ? {
        ownerKind: 'run_owner' as const,
        ...shared,
        action: action as 'stop' | 'reset' | 'close',
        targetReadyRunId: input.base.activeReadyRunId as string,
      }
    : {
        ownerKind: 'head_owner' as const,
        ...shared,
        action: action as 'reset' | 'close' | 'manual_compact',
        threadBindingId: input.threadBindingId,
        headRevision: input.headRevision,
        materializationIntentRef: input.materializationIntentRef,
      }
  return { ...unsigned, digest: digestCanonicalJson(unsigned) }
}

function gate(
  input: CodexLifecycleActionSurfaceFacts,
  action: Action,
  availability: LifecycleActionGate['availability'],
  blockers: LifecycleActionBlockingReason[],
): LifecycleActionGate {
  const canonical = orderedBlockers(blockers)
  return {
    availability,
    blockers: canonical,
    requestRef: availability === 'ready' ? requestRef(input, action) : null,
  }
}

export function projectCodexLifecycleOperationV2(
  input: CodexLifecycleActionSurfaceFacts,
): LifecycleOperationProjectionV2 {
  const headIdentity = input.head.actionHeadIdentity
  if (!headIdentity
    || input.base.identity.aliasId !== headIdentity.aliasId
    || input.base.identity.aliasGeneration !== headIdentity.aliasGeneration
    || input.head.scopeId !== input.base.identity.aliasId
    || input.scopeEpoch !== input.head.actionProjectionVersion.scopeEpoch
    || input.threadBindingId !== headIdentity.threadBindingId
    || input.headRevision !== headIdentity.headRevision) {
    throw new Error('codex_lifecycle_head_identity_mismatch')
  }
  const snapshot = input.base.snapshot
  const activeRun = Boolean(input.base.activeReadyRunId)
  const headBlockers = input.head.actions.send_new_message.blockers
  const legacyPreparedBoundary = headBlockers.includes('legacy_prepared_contract')
  const isProductOwner = activeRun && (
    snapshot === 'thread_start_pending'
    || snapshot === 'turn_start_pending'
    || snapshot === 'product_turn_interruptible'
    || snapshot === 'product_turn_interrupt_unknown'
    || snapshot === 'product_turn_engine_terminal_closeout_pending'
    || snapshot === 'host_failure_closeout_pending'
    || legacyPreparedBoundary
  )
  const resetCloseReady = snapshot !== 'invariant_violation' || legacyPreparedBoundary
  const stopGate = snapshot === 'product_turn_interruptible'
    ? gate(input, 'stop', 'ready', [])
    : snapshot === 'product_turn_interrupt_unknown' && input.base.requestedAction === 'stop'
      ? gate(input, 'stop', 'ready', [])
      : snapshot === 'product_turn_interrupt_unknown'
        ? gate(input, 'stop', 'blocked', ['interrupt_state_unknown'])
      : gate(input, 'stop', 'not_applicable', ['no_active_operation'])
  const resetGate = snapshot === 'product_turn_interrupt_unknown'
    && input.base.requestedAction !== 'reset'
    ? gate(input, 'reset', 'blocked', ['interrupt_state_unknown'])
    : resetCloseReady
    ? gate(input, 'reset', 'ready', [])
    : gate(input, 'reset', 'blocked', ['thread_busy'])
  const closeGate = snapshot === 'product_turn_interrupt_unknown'
    && input.base.requestedAction !== 'close'
    ? gate(input, 'close', 'blocked', ['interrupt_state_unknown'])
    : resetCloseReady
    ? gate(input, 'close', 'ready', [])
    : gate(input, 'close', 'blocked', ['thread_busy'])
  if ((resetGate.availability === 'ready'
      && (resetGate.requestRef?.ownerKind === 'run_owner') !== isProductOwner)
    || (closeGate.availability === 'ready'
      && (closeGate.requestRef?.ownerKind === 'run_owner') !== isProductOwner)) {
    throw new Error('codex_lifecycle_owner_projection_mismatch')
  }
  let manualGate: LifecycleActionGate
  if (snapshot === 'manual_compaction_pending') {
    manualGate = gate(input, 'manual_compact', 'blocked', ['manual_compaction_pending'])
  } else if (snapshot === 'manual_compaction_unknown') {
    manualGate = gate(input, 'manual_compact', 'blocked', ['manual_compaction_unknown'])
  } else if (input.manualCompactionRuntimeBlocker) {
    manualGate = gate(input, 'manual_compact', 'blocked', [input.manualCompactionRuntimeBlocker])
  } else if (input.head.historyState === 'legacy_context_boundary') {
    manualGate = gate(input, 'manual_compact', 'not_applicable', ['legacy_context_boundary'])
  } else if (snapshot === 'idle_native_thread' && headBlockers.length === 0) {
    manualGate = gate(input, 'manual_compact', 'ready', [])
  } else {
    const mapped = headBlockers.flatMap((blocker): LifecycleActionBlockingReason[] => {
      if (blocker === 'head_contract_drift') return ['head_contract_drift']
      if (blocker === 'legacy_prepared_contract') return ['legacy_prepared_contract']
      if (blocker === 'history_outcome_unknown' || blocker === 'terminal_history_unknown') {
        return ['history_outcome_unknown']
      }
      if (blocker === 'history_materializing') return ['history_materializing']
      if (blocker === 'manual_compaction_unknown') return ['manual_compaction_unknown']
      if (blocker === 'manual_compaction_pending') return ['manual_compaction_pending']
      if (blocker === 'thread_busy') return ['thread_busy']
      return []
    })
    manualGate = gate(
      input,
      'manual_compact',
      mapped.length > 0 ? 'blocked' : 'not_applicable',
      mapped.length > 0 ? mapped : ['no_active_operation'],
    )
  }
  const { evidenceDigest: _baseEvidenceDigest, ...baseWithoutDigest } = input.base
  const unsigned = {
    ...baseWithoutDigest,
    contractVersion: 'ready_lifecycle_operation_projection_v2' as const,
    scopeId: input.head.scopeId,
    scopeEpoch: input.scopeEpoch,
    headProjectionRef: {
      version: input.head.actionProjectionVersion,
      digest: input.head.evidenceDigest,
    },
    actions: {
      stop: stopGate,
      reset: resetGate,
      close: closeGate,
      manual_compact: manualGate,
    },
  }
  return { ...unsigned, evidenceDigest: digestCanonicalJson(unsigned) }
}

export function assertCodexLifecycleOperationV2(value: LifecycleOperationProjectionV2): void {
  for (const [action, gateValue] of Object.entries(value.actions) as Array<[
    Action,
    LifecycleActionGate,
  ]>) {
    const positions = gateValue.blockers.map((reason) => (
      LIFECYCLE_ACTION_BLOCKER_PRECEDENCE.indexOf(reason)
    ))
    if (new Set(gateValue.blockers).size !== gateValue.blockers.length
      || positions.some((position, index) => position < 0
        || (index > 0 && position < positions[index - 1]))
      || (gateValue.availability === 'ready') !== (gateValue.blockers.length === 0)
      || (gateValue.availability === 'ready') !== Boolean(gateValue.requestRef)
      || (gateValue.requestRef && gateValue.requestRef.action !== action)) {
      throw new Error('codex_lifecycle_action_gate_invalid')
    }
  }
  const { evidenceDigest, ...unsigned } = value
  if (evidenceDigest !== digestCanonicalJson(unsigned)) {
    throw new Error('codex_lifecycle_projection_digest_invalid')
  }
}
