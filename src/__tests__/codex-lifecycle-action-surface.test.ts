import assert from 'node:assert/strict'
import test from 'node:test'

import { projectCodexHeadActionProjection } from '../main/modules/agent-control/codex-runtime/codex-action-surface'
import {
  assertCodexLifecycleOperationV2,
  projectCodexLifecycleOperationV2,
} from '../main/modules/agent-control/codex-runtime/codex-lifecycle-action-surface'
import { digestCanonicalJson } from '../main/modules/agent-control/codex-runtime/codex-model-gateway-contract'
import { parseLifecycleOperationProjectionV2 } from '../shared/ipc-contracts/agent-lifecycle-snapshot'

function projection(input: {
  snapshot: 'idle_native_thread' | 'product_turn_interruptible' | 'product_turn_interrupt_unknown' | 'invariant_violation'
  activeReadyRunId?: string | null
  requestedAction?: 'stop' | 'reset' | 'close' | null
  legacy?: boolean
  legacyPrepared?: boolean
  manualCompactionRuntimeBlocker?: 'runtime_unverified' | 'runtime_unsupported'
}) {
  const head = projectCodexHeadActionProjection({
    scopeId: 'scope-1', scopeEpoch: 2, aliasId: 'scope-1', aliasGeneration: 3,
    threadBindingId: 'binding-3', headRevision: 4, actionProjectionSequence: 5,
    materializationKind: input.legacy ? 'legacy' : 'fresh_start',
    materializationState: 'confirmed', codexThreadId: 'thread-3',
    continuationBlocked: false, activeProductFence: Boolean(input.activeReadyRunId),
    manualCompactionState: 'none', hasLegacyPreparedRun: input.legacyPrepared === true,
    headRuntimeManifestDigest: 'runtime', headProtocolSchemaDigest: 'protocol',
    currentRuntimeManifestDigest: 'runtime', currentProtocolSchemaDigest: 'protocol',
  })
  const base = {
    identity: { aliasId: 'scope-1', aliasGeneration: 3 },
    activeReadyRunId: input.activeReadyRunId ?? null,
    latestReadyRunId: input.activeReadyRunId ?? 'run-old',
    snapshot: input.snapshot,
    interruptRequested: input.snapshot === 'product_turn_interrupt_unknown',
    interruptAcknowledged: false,
    requestedAction: input.requestedAction ?? null,
    evidenceDigest: digestCanonicalJson(input),
  }
  return projectCodexLifecycleOperationV2({
    base, head, scopeEpoch: 2, threadBindingId: 'binding-3', headRevision: 4,
    materializationIntentRef: null,
    manualCompactionRuntimeBlocker: input.manualCompactionRuntimeBlocker,
  })
}

test('lifecycle V2 freezes the exact action owner instead of deriving from latest run', () => {
  const idle = projection({ snapshot: 'idle_native_thread' })
  assert.equal(idle.actions.stop.availability, 'not_applicable')
  assert.equal(idle.actions.reset.requestRef?.ownerKind, 'head_owner')
  assert.equal(idle.actions.close.requestRef?.ownerKind, 'head_owner')
  assert.equal(idle.actions.manual_compact.availability, 'ready')
  assertCodexLifecycleOperationV2(idle)
  assert.deepEqual(parseLifecycleOperationProjectionV2(idle), idle)

  const active = projection({
    snapshot: 'product_turn_interruptible', activeReadyRunId: 'run-active',
  })
  assert.equal(active.actions.stop.requestRef?.ownerKind, 'run_owner')
  assert.equal(active.actions.reset.requestRef?.ownerKind, 'run_owner')
  assert.equal(active.actions.close.requestRef?.ownerKind, 'run_owner')
  assert.equal(active.actions.manual_compact.availability, 'blocked')
  assert.equal(
    active.actions.stop.requestRef?.ownerKind === 'run_owner'
      ? active.actions.stop.requestRef.targetReadyRunId
      : null,
    'run-active',
  )
})

test('interrupt uncertainty exposes only the exact requested action and legacy blocks compaction', () => {
  const uncertain = projection({
    snapshot: 'product_turn_interrupt_unknown',
    activeReadyRunId: 'run-active',
    requestedAction: 'stop',
  })
  assert.equal(uncertain.actions.stop.availability, 'ready')
  assert.equal(uncertain.actions.reset.availability, 'blocked')
  assert.equal(uncertain.actions.close.availability, 'blocked')
  const legacy = projection({ snapshot: 'idle_native_thread', legacy: true })
  assert.deepEqual(legacy.actions.manual_compact.blockers, ['legacy_context_boundary'])

  const legacyPrepared = projection({
    snapshot: 'invariant_violation',
    legacyPrepared: true,
  })
  assert.equal(legacyPrepared.actions.stop.availability, 'not_applicable')
  assert.equal(legacyPrepared.actions.reset.requestRef?.ownerKind, 'head_owner')
  assert.equal(legacyPrepared.actions.close.requestRef?.ownerKind, 'head_owner')
  assert.deepEqual(legacyPrepared.actions.manual_compact.blockers, ['legacy_prepared_contract'])

  const unverifiedCompaction = projection({
    snapshot: 'idle_native_thread', manualCompactionRuntimeBlocker: 'runtime_unverified',
  })
  assert.equal(unverifiedCompaction.actions.manual_compact.availability, 'blocked')
  assert.deepEqual(unverifiedCompaction.actions.manual_compact.blockers, ['runtime_unverified'])
})
