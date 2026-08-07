import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  CodexBindingRecoveryMember,
  CodexBindingRecoverySnapshot,
} from '../main/modules/agent-control/codex-runtime/codex-binding-repository'
import type { VerifiedCodexRuntime } from '../main/modules/agent-control/codex-runtime/codex-runtime-host'
import {
  CodexRuntimeBootReconciler,
  type CodexBootRecoveryActions,
  type CodexRuntimeIngressGate,
} from '../main/modules/agent-control/codex-runtime/codex-runtime-boot-reconciler'

function member(input: Partial<CodexBindingRecoveryMember> & Pick<
  CodexBindingRecoveryMember,
  'reservationSetId' | 'reservationId' | 'method' | 'bindingId' | 'state' | 'crashSeam'
>): CodexBindingRecoveryMember {
  return {
    scopeId: `scope-${input.reservationSetId}`,
    requiredMemberCount: input.method === 'thread/start' ? 2 : 1,
    connectionEpoch: input.state === 'held' ? null : `old-${input.reservationId}`,
    rpcId: input.state === 'held' ? null : input.crashSeam,
    ...input,
  }
}

function sixSeamSnapshot(): CodexBindingRecoverySnapshot {
  return {
    members: [
      member({
        reservationSetId: 'set-seam-1', reservationId: 'member-seam-1',
        method: 'thread/start', bindingId: 'thread-seam-1', state: 'held', crashSeam: 1,
      }),
      member({
        reservationSetId: 'set-seam-1', reservationId: 'turn-after-seam-1',
        method: 'turn/start', bindingId: 'run-after-seam-1', state: 'held', crashSeam: 4,
        requiredMemberCount: 2,
      }),
      member({
        reservationSetId: 'set-seam-2', reservationId: 'member-seam-2',
        method: 'thread/start', bindingId: 'thread-seam-2', state: 'recovery_held', crashSeam: 2,
      }),
      member({
        reservationSetId: 'set-seam-2', reservationId: 'turn-after-seam-2',
        method: 'turn/start', bindingId: 'run-after-seam-2', state: 'held', crashSeam: 4,
        requiredMemberCount: 2,
      }),
      member({
        reservationSetId: 'set-seam-3', reservationId: 'member-seam-3',
        method: 'thread/start', bindingId: 'thread-seam-3', state: 'recovery_held', crashSeam: 3,
      }),
      member({
        reservationSetId: 'set-seam-3', reservationId: 'turn-after-seam-3',
        method: 'turn/start', bindingId: 'run-after-seam-3', state: 'held', crashSeam: 4,
        requiredMemberCount: 2,
      }),
      member({
        reservationSetId: 'set-seam-5', reservationId: 'member-seam-5',
        method: 'turn/start', bindingId: 'run-seam-5', state: 'recovery_held', crashSeam: 5,
      }),
      member({
        reservationSetId: 'set-seam-6', reservationId: 'member-seam-6',
        method: 'turn/start', bindingId: 'run-seam-6', state: 'recovery_held', crashSeam: 6,
      }),
      member({
        reservationSetId: 'set-host-failure', reservationId: 'member-host-failure',
        method: 'turn/start', bindingId: 'run-host-failure', state: 'recovery_held', crashSeam: 6,
      }),
    ],
    lateResponseGuards: [],
    hostFailureCloseouts: [{
      readyRunId: 'run-host-failure',
      reservationSetId: 'set-host-failure',
      kind: 'turn_start_delivery_proven_absent',
      evidenceDigest: 'host-failure-evidence',
      continuationBlockedReason: 'publication_diverged',
    }],
    manualCompactions: [{
      manualCompactionId: 'manual-1', threadBindingId: 'thread-manual-1',
      codexThreadId: 'thread-native-manual-1', state: 'pending', fenceQuarantined: false,
    }],
    productFences: [{
      threadBindingId: 'thread-product-1', readyRunId: 'run-product-1',
      ownerMainBootId: 'old-main-boot',
      quarantinedAt: null,
      quarantineReason: null,
    }],
  }
}

function runtime(capacity = 64): VerifiedCodexRuntime {
  return {
    manifest: { startIdentityRegistryCapacity: capacity },
  } as unknown as VerifiedCodexRuntime
}

test('boot settles process ownership, restores capacity, covers six seams, then opens ingress', async () => {
  const events: string[] = []
  const snapshot = sixSeamSnapshot()
  const reservationByRun = new Map([
    ['run-host-failure', 'set-host-failure'],
    ['run-seam-3', 'set-seam-3'],
  ])
  const repository = {
    readRecoverySnapshot() {
      events.push('snapshot')
      return snapshot
    },
    recordHostFailureEvidence(input: { readyRunId: string }) {
      events.push(`failure-evidence:${input.readyRunId}`)
    },
    completeHostFailureCloseout(input: { readyRunId: string }) {
      events.push(`failure-closeout:${input.readyRunId}`)
      return { reservationSetId: reservationByRun.get(input.readyRunId) as string }
    },
    reconcileStartAccepted(input: { bindingId: string }) {
      events.push(`accepted:${input.bindingId}`)
    },
    closeLateResponseGuardsForConnection(epoch: string) {
      events.push(`guards-closed:${epoch}`)
      return 1
    },
    readProductRunForThreadBinding(threadBindingId: string) {
      assert.equal(threadBindingId, 'thread-seam-3')
      return 'run-seam-3'
    },
    quarantineStartInbound(input: { bindingId: string }) {
      events.push(`quarantine:${input.bindingId}`)
    },
  }
  const actions: CodexBootRecoveryActions = {
    async dispatchHeldStart({ member: current }) {
      events.push(`held:${current.crashSeam}:${current.bindingId}`)
      return 'pending'
    },
    async resolveIntentStart({ member: current }) {
      events.push(`intent:${current.crashSeam}:${current.bindingId}`)
      if (current.crashSeam === 2 || current.crashSeam === 5) {
        return {
          resolution: 'accepted',
          nativeId: `native-${current.bindingId}`,
          nativeResult: { fixture: current.bindingId },
          evidenceDigest: `accepted-evidence-${current.bindingId}`,
        }
      }
      if (current.crashSeam === 3) {
        return { resolution: 'proven_absent', evidenceDigest: 'stable-zero-seam-3' }
      }
      return { resolution: 'unknown', evidenceDigest: `unknown-${current.bindingId}` }
    },
    async commitHostFailureProductTerminal({ failure }) {
      events.push(`product-terminal:${failure.readyRunId}`)
      return { productTerminalDigest: `terminal-${failure.readyRunId}` }
    },
    async reconcileManualCompaction(input) {
      events.push(`manual:${input.manualCompactionId}`)
    },
    async reconcileProductFence(input) {
      events.push(`product-fence:${input.readyRunId}`)
    },
  }
  const gate: CodexRuntimeIngressGate = {
    open() { events.push('gate:open') },
    close(reason) { events.push(`gate:closed:${reason}`) },
  }
  const reconciler = new CodexRuntimeBootReconciler({
    runtime: runtime(),
    repository: repository as never,
    supervisor: {
      async settleBootLease() { events.push('process-lease'); return 'settled' },
    },
    sidecarSession: {
      async startAndInitialize() {
        events.push('sidecar-initialized')
        return { connectionEpoch: 'new-epoch' }
      },
      isConnectionLive() { return false },
      sealBootReconciliation() { events.push('sidecar-sealed') },
    },
    actions,
    ingressGate: gate,
    now: () => '2026-08-07T02:00:00.000Z',
  })

  const result = await reconciler.boot()
  assert.equal(result.connectionEpoch, 'new-epoch')
  assert.deepEqual(result.unresolvedStartBindings, ['run-seam-6'])
  assert.equal(result.registry.snapshot().capacityCharged, 4)
  assert.ok(events.indexOf('process-lease') < events.indexOf('snapshot'))
  assert.ok(events.indexOf('snapshot') < events.indexOf('sidecar-initialized'))
  assert.ok(events.indexOf('failure-closeout:run-host-failure') < events.indexOf('intent:2:thread-seam-2'))
  assert.ok(events.includes('held:1:thread-seam-1'))
  assert.equal(events.includes('held:4:run-after-seam-1'), false)
  assert.ok(events.includes('held:4:run-after-seam-2'))
  assert.equal(events.includes('held:4:run-after-seam-3'), false)
  assert.ok(events.includes('intent:2:thread-seam-2'))
  assert.ok(events.includes('intent:3:thread-seam-3'))
  assert.ok(events.includes('intent:5:run-seam-5'))
  assert.ok(events.includes('intent:6:run-seam-6'))
  assert.ok(events.includes('quarantine:run-seam-6'))
  assert.deepEqual(events.slice(-4), [
    'manual:manual-1',
    'product-fence:run-product-1',
    'sidecar-sealed',
    'gate:open',
  ])
  await assert.rejects(reconciler.boot(), /boot_reconciliation_already_completed/)
})

test('unknown root intent keeps the held turn in the same reservation set blocked', async () => {
  const events: string[] = []
  const snapshot: CodexBindingRecoverySnapshot = {
    members: [
      member({
        reservationSetId: 'set-root-unknown', reservationId: 'thread-member',
        method: 'thread/start', bindingId: 'thread-unknown', state: 'recovery_held', crashSeam: 3,
      }),
      member({
        reservationSetId: 'set-root-unknown', reservationId: 'turn-member',
        method: 'turn/start', bindingId: 'run-held', state: 'held', crashSeam: 4,
        requiredMemberCount: 2,
      }),
    ],
    lateResponseGuards: [],
    hostFailureCloseouts: [],
    manualCompactions: [],
    productFences: [{
      threadBindingId: 'thread-unknown',
      readyRunId: 'run-held',
      ownerMainBootId: 'old-main',
      quarantinedAt: null,
      quarantineReason: null,
    }],
  }
  const reconciler = new CodexRuntimeBootReconciler({
    runtime: runtime(),
    repository: {
      readRecoverySnapshot: () => snapshot,
      readProductRunForThreadBinding: () => 'run-held',
      quarantineStartInbound(input: { bindingId: string }) {
        events.push(`quarantine:${input.bindingId}`)
      },
    } as never,
    supervisor: { async settleBootLease() { return 'none' } },
    sidecarSession: {
      async startAndInitialize() { return { connectionEpoch: 'new-epoch' } },
      isConnectionLive() { return false },
      sealBootReconciliation() { events.push('sealed') },
    },
    actions: {
      async dispatchHeldStart({ member: current }) {
        events.push(`dispatched:${current.bindingId}`)
        return 'pending'
      },
      async resolveIntentStart() {
        return { resolution: 'unknown', evidenceDigest: 'unknown-root-evidence' }
      },
      async commitHostFailureProductTerminal() { throw new Error('unexpected') },
      async reconcileManualCompaction() { throw new Error('unexpected') },
      async reconcileProductFence() { events.push('unexpected-fence') },
    },
    ingressGate: { open() { events.push('open') }, close() {} },
    now: () => '2026-08-07T02:00:00.000Z',
  })

  const result = await reconciler.boot()
  assert.deepEqual(result.unresolvedStartBindings, ['thread-unknown'])
  assert.deepEqual(events, ['quarantine:thread-unknown', 'sealed', 'open'])
})

test('capacity recovery overflow keeps ingress closed and performs no binding action', async () => {
  const events: string[] = []
  const overflow: CodexBindingRecoverySnapshot = {
    members: [
      member({
        reservationSetId: 'lazy', reservationId: 'lazy-thread', method: 'thread/start',
        bindingId: 'thread-lazy', state: 'held', crashSeam: 1,
      }),
      member({
        reservationSetId: 'lazy', reservationId: 'lazy-turn', method: 'turn/start',
        bindingId: 'run-lazy', state: 'held', crashSeam: 4, requiredMemberCount: 2,
      }),
      member({
        reservationSetId: 'existing', reservationId: 'existing-turn', method: 'turn/start',
        bindingId: 'run-existing', state: 'held', crashSeam: 4,
      }),
    ],
    lateResponseGuards: [],
    hostFailureCloseouts: [],
    manualCompactions: [],
    productFences: [],
  }
  const reconciler = new CodexRuntimeBootReconciler({
    runtime: runtime(2),
    repository: {
      readRecoverySnapshot: () => overflow,
    } as never,
    supervisor: { async settleBootLease() { return 'none' } },
    sidecarSession: {
      async startAndInitialize() { return { connectionEpoch: 'new-epoch' } },
      isConnectionLive() { return false },
      sealBootReconciliation() { events.push('unexpected-seal') },
    },
    actions: {
      async dispatchHeldStart() { events.push('unexpected-action'); return 'pending' },
      async resolveIntentStart() { throw new Error('unexpected-action') },
      async commitHostFailureProductTerminal() { throw new Error('unexpected-action') },
      async reconcileManualCompaction() { throw new Error('unexpected-action') },
      async reconcileProductFence() { throw new Error('unexpected-action') },
    },
    ingressGate: {
      open() { events.push('unexpected-open') },
      close(reason) { events.push(`closed:${reason}`) },
    },
    now: () => '2026-08-07T02:00:00.000Z',
  })
  await assert.rejects(reconciler.boot(), /start_identity_capacity_recovery_overflow/)
  assert.equal(events.includes('unexpected-action'), false)
  assert.equal(events.includes('unexpected-open'), false)
  assert.match(events.at(-1) || '', /start_identity_capacity_recovery_overflow/)
})

test('process ownership failure prevents sidecar start, snapshot reads, and ingress', async () => {
  const events: string[] = []
  const reconciler = new CodexRuntimeBootReconciler({
    runtime: runtime(),
    repository: { readRecoverySnapshot() { events.push('snapshot'); throw new Error('unexpected') } } as never,
    supervisor: {
      async settleBootLease() {
        events.push('process-lease')
        throw new Error('old_main_owner_still_alive')
      },
    },
    sidecarSession: {
      async startAndInitialize() { events.push('sidecar'); return { connectionEpoch: 'epoch' } },
      isConnectionLive() { return false },
      sealBootReconciliation() { events.push('seal') },
    },
    actions: {} as CodexBootRecoveryActions,
    ingressGate: {
      open() { events.push('open') },
      close(reason) { events.push(`closed:${reason}`) },
    },
    now: () => '2026-08-07T02:00:00.000Z',
  })
  await assert.rejects(reconciler.boot(), /old_main_owner_still_alive/)
  assert.deepEqual(events, [
    'closed:boot_reconciliation_pending',
    'process-lease',
    'closed:old_main_owner_still_alive',
  ])
})
