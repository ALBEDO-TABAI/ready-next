import assert from 'node:assert/strict'
import test from 'node:test'

import { CodexManualCompactionController } from '../main/modules/agent-control/codex-runtime/codex-manual-compaction-controller'
import { digestCanonicalJson } from '../main/modules/agent-control/codex-runtime/codex-model-gateway-contract'
import type {
  CodexBindingRepository,
  CodexManualCompactionRecovery,
} from '../main/modules/agent-control/codex-runtime/codex-binding-repository'
import type { CodexModelGatewayRepository } from '../main/modules/agent-control/codex-runtime/codex-model-gateway-authority'
import type { CodexSidecarSession } from '../main/modules/agent-control/codex-runtime/codex-sidecar-session'

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('wait_for_timeout')
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

test('production manual compaction binds before RPC evidence and consumes inside exact reconciliation', async () => {
  const calls: string[] = []
  let beginInput: Record<string, unknown> | null = null
  let consumeInput: Record<string, unknown> | null = null
  const repository = {
    readManualCompactionRoute() {
      calls.push('route')
      return {
        threadBindingId: 'thread-binding-1', aliasId: 'scope-1', aliasGeneration: 1,
        codexThreadId: 'thread-1', codexModel: 'ready-e0-model',
        upstreamProfileSnapshotRef: 'snapshot-1', upstreamProfileSnapshotDigest: 'snapshot-digest-1',
      }
    },
    beginManualCompaction(input: Record<string, unknown>) {
      calls.push('begin')
      beginInput = input
      return { manualCompactionId: String(input.manualCompactionId), codexThreadId: 'thread-1' }
    },
    consumeManualCompaction(input: Record<string, unknown>) {
      calls.push('consume')
      consumeInput = input
    },
  } as unknown as CodexBindingRepository
  const snapshot = {
    profileId: 'profile-1', credentialReferenceId: 'credential-1',
  }
  const gatewayRepository = {
    readSnapshot(ref: string, digest: string) {
      calls.push('snapshot')
      assert.equal(ref, 'snapshot-1')
      assert.equal(digest, 'snapshot-digest-1')
      return snapshot
    },
    readManualCompactionGatewayEvidence() {
      calls.push('gateway-evidence')
      return {
        receiptId: 'gateway-receipt-1',
        upstreamProfileSnapshotDigest: 'snapshot-digest-1',
        toolsDigest: digestCanonicalJson([]),
        toolCount: 0,
        requestEvidenceDigest: 'request-evidence-1',
        responseEvidenceDigest: 'response-evidence-1',
      }
    },
  } as unknown as CodexModelGatewayRepository
  let manualCompactionId = ''
  const inboundBuffer = {
    registerProvisionalManualCompaction(input: { manualCompactionId: string }) {
      calls.push('register')
      manualCompactionId = input.manualCompactionId
    },
    readManualCompactionEvidence(id: string) {
      calls.push('evidence')
      assert.equal(id, manualCompactionId)
      return {
        turnId: 'turn-compact-1',
        contextCompactionItemId: 'item-notification-compact-1',
        terminalStatus: 'completed',
      }
    },
    async reconcileTurn(input: { bindingId: string; connectionEpoch: string; threadId: string; nativeTurnId: string }, commit: () => void) {
      calls.push('reconcile')
      assert.deepEqual(input, {
        bindingId: manualCompactionId,
        connectionEpoch: 'connection-1',
        threadId: 'thread-1',
        nativeTurnId: 'turn-compact-1',
      })
      commit()
      return 'released' as const
    },
  }
  const session = {
    getClient: () => ({
      async threadRead() {
        calls.push('pre-read')
        return {
          thread: {
            id: 'thread-1',
            turns: [],
          },
        }
      },
    }),
    getActiveConnectionEpoch: () => 'connection-1',
    getInboundBuffer: () => inboundBuffer,
    isConnectionLive: (epoch: string) => epoch === 'connection-1',
  } as unknown as CodexSidecarSession
  const controller = new CodexManualCompactionController({
    repository,
    gatewayRepository,
    getSession: () => session,
    ensureThreadLoaded: async () => undefined,
    ownerMainBootId: 'main-boot-1',
    timeoutMs: 20_000,
    now: () => '2026-08-07T00:00:00.000Z',
    nowMs: () => 1_000,
  })

  const started = await controller.begin({ aliasId: 'scope-1', aliasGeneration: 1 })
  assert.equal(started.threadId, 'thread-1')
  assert.equal(started.manualCompactionId, manualCompactionId)
  assert.equal(beginInput?.expectedToolsDigest, digestCanonicalJson([]))
  assert.equal(beginInput?.credentialReferenceId, 'credential-1')
  assert.deepEqual(calls.slice(0, 5), ['route', 'snapshot', 'pre-read', 'begin', 'register'])

  const completed = await controller.awaitCompletion({
    identity: { aliasId: 'scope-1', aliasGeneration: 1 },
    manualCompactionId,
  })
  assert.deepEqual(completed, {
    codexTurnId: 'turn-compact-1',
    notificationContextCompactionItemId: 'item-notification-compact-1',
  })
  await controller.consume({
    identity: { aliasId: 'scope-1', aliasGeneration: 1 },
    manualCompactionId,
    codexTurnId: completed.codexTurnId,
    notificationContextCompactionItemId: completed.notificationContextCompactionItemId,
    contextCompactionItemId: 'item-readback-compact-1',
    threadReadDigest: 'thread-read-digest-1',
    terminalEvidenceDigest: 'terminal-evidence-1',
  })
  assert.deepEqual(calls.slice(-2), ['reconcile', 'consume'])
  assert.equal(consumeInput?.codexCompactionTurnId, 'turn-compact-1')
  assert.equal(consumeInput?.notificationContextCompactionItemId, 'item-notification-compact-1')
  assert.equal(consumeInput?.contextCompactionItemId, 'item-readback-compact-1')
})

test('manual compaction connection loss stays unknown and never consumes', async () => {
  let consumed = false
  let unknownInput: Record<string, unknown> | null = null
  const repository = {
    readManualCompactionRoute: () => ({
      threadBindingId: 'thread-binding-1', aliasId: 'scope-1', aliasGeneration: 1,
      codexThreadId: 'thread-1', codexModel: 'ready-e0-model',
      upstreamProfileSnapshotRef: 'snapshot-1', upstreamProfileSnapshotDigest: 'snapshot-digest-1',
    }),
    beginManualCompaction: (input: { manualCompactionId: string }) => ({
      manualCompactionId: input.manualCompactionId, codexThreadId: 'thread-1',
    }),
    consumeManualCompaction: () => { consumed = true },
    recordManualCompactionUnknown(input: Record<string, unknown>) { unknownInput = input },
  } as unknown as CodexBindingRepository
  const inboundBuffer = {
    registerProvisionalManualCompaction() {},
    readManualCompactionEvidence: () => null,
  }
  const session = {
    getClient: () => ({
      async threadRead() { return { thread: { id: 'thread-1', turns: [] } } },
    }),
    getActiveConnectionEpoch: () => 'connection-1',
    getInboundBuffer: () => inboundBuffer,
    isConnectionLive: () => false,
  } as unknown as CodexSidecarSession
  const controller = new CodexManualCompactionController({
    repository,
    gatewayRepository: {
      readSnapshot: () => ({ profileId: 'profile-1', credentialReferenceId: 'credential-1' }),
    } as unknown as CodexModelGatewayRepository,
    getSession: () => session,
    ensureThreadLoaded: async () => undefined,
    ownerMainBootId: 'main-boot-1',
    timeoutMs: 20_000,
    now: () => '2026-08-07T00:00:00.000Z',
    nowMs: () => 1_000,
  })
  const started = await controller.begin({ aliasId: 'scope-1', aliasGeneration: 1 })
  await assert.rejects(
    controller.awaitCompletion({
      identity: { aliasId: 'scope-1', aliasGeneration: 1 },
      manualCompactionId: started.manualCompactionId,
    }),
    /manual_compaction_connection_closed/,
  )
  controller.markUnknown({
    identity: { aliasId: 'scope-1', aliasGeneration: 1 },
    manualCompactionId: started.manualCompactionId,
    reason: 'manual_compaction_connection_closed',
  })
  assert.equal(consumed, false)
  assert.equal(unknownInput?.reason, 'manual_compaction_connection_closed')
  assert.ok(unknownInput?.evidenceDigest)
})

test('boot recovery retries only a dispatch proven not written and consumes exact readback', async () => {
  const calls: string[] = []
  let consumeInput: Record<string, unknown> | null = null
  const repository = {
    proveManualCompactionAttemptAbsent() { calls.push('prove-absent') },
    renewManualCompactionRecoveryWindow() { calls.push('renew') },
    consumeManualCompaction(input: Record<string, unknown>) {
      calls.push('consume')
      consumeInput = input
    },
  } as unknown as CodexBindingRepository
  const inboundBuffer = {
    registerProvisionalManualCompaction() { calls.push('register') },
    readManualCompactionEvidence() {
      return {
        turnId: 'compact-turn-new',
        contextCompactionItemId: 'compact-notification-item-new',
        terminalStatus: 'completed',
      }
    },
    async reconcileTurn(_input: unknown, commit: () => void) {
      commit()
      return 'released' as const
    },
  }
  const thread = {
    id: 'thread-1',
    turns: [{
      id: 'compact-turn-new', status: 'completed', error: null,
      items: [{ type: 'contextCompaction', id: 'compact-readback-item-new' }],
    }],
  }
  const session = {
    getActiveConnectionEpoch: () => 'new-epoch',
    getInboundBuffer: () => inboundBuffer,
    isConnectionLive: () => true,
    getClient: () => ({
      async threadCompactStart() { calls.push('dispatch') },
      async threadRead() { calls.push('readback'); return { thread } },
    }),
  } as unknown as CodexSidecarSession
  const controller = new CodexManualCompactionController({
    repository,
    gatewayRepository: {
      readManualCompactionGatewayEvidence: () => ({
        receiptId: 'gateway-receipt',
        upstreamProfileSnapshotDigest: 'snapshot-digest',
        toolsDigest: digestCanonicalJson([]),
        toolCount: 0,
        requestEvidenceDigest: 'request-evidence',
        responseEvidenceDigest: 'response-evidence',
      }),
    } as unknown as CodexModelGatewayRepository,
    getSession: () => session,
    ensureThreadLoaded: async (identity) => {
      assert.deepEqual(identity, { aliasId: 'alias-1', aliasGeneration: 1 })
      calls.push('ensure-loaded')
    },
    ownerMainBootId: 'new-main',
    timeoutMs: 20_000,
    now: () => '2026-08-07T00:00:00.000Z',
    nowMs: () => 1_000,
  })
  assert.equal(await controller.reconcileRecovery({
    manualCompactionId: 'manual-1', threadBindingId: 'binding-1', codexThreadId: 'thread-1',
    codexCompactionTurnId: null, preDispatchThreadReadDigest: 'pre-read', preDispatchTurnIds: [],
    aliasId: 'alias-1', aliasGeneration: 1, upstreamProfileSnapshotDigest: 'snapshot-digest',
    unknownAt: null, unknownReason: null, state: 'pending', fenceQuarantined: false,
    latestAttempt: {
      connectionEpoch: 'old-epoch', rpcId: 4, childWriteAttemptedAt: null,
      childWriteConfirmedAt: null, unresolvedReason: 'connection_closed', responseKind: null,
    },
  }), 'observing')
  await waitFor(() => calls.includes('consume'))
  // 2026-10-07: after a restart the thread is not loaded and Codex answers “thread not found” to the redispatch.
  assert.deepEqual(calls, [
    'prove-absent', 'renew', 'register', 'ensure-loaded', 'dispatch', 'readback', 'consume',
  ])
  assert.equal(consumeInput?.notificationContextCompactionItemId, 'compact-notification-item-new')
  assert.equal(consumeInput?.contextCompactionItemId, 'compact-readback-item-new')
})

test('boot recovery marks a possibly written unclaimed compaction unknown without redispatch', async () => {
  const unknown: Array<Record<string, unknown>> = []
  const repository = {
    recordManualCompactionUnknown(input: Record<string, unknown>) { unknown.push(input) },
  } as unknown as CodexBindingRepository
  let dispatches = 0
  const session = {
    getClient: () => ({ async threadCompactStart() { dispatches += 1 } }),
  } as unknown as CodexSidecarSession
  const controller = new CodexManualCompactionController({
    repository,
    gatewayRepository: {} as CodexModelGatewayRepository,
    getSession: () => session,
    ensureThreadLoaded: async () => undefined,
    ownerMainBootId: 'new-main', timeoutMs: 20_000,
    now: () => '2026-08-07T00:00:00.000Z', nowMs: () => 1_000,
  })
  await controller.reconcileRecovery({
    manualCompactionId: 'manual-1', threadBindingId: 'binding-1', codexThreadId: 'thread-1',
    codexCompactionTurnId: null, preDispatchThreadReadDigest: 'pre-read', preDispatchTurnIds: [],
    aliasId: 'alias-1', aliasGeneration: 1, upstreamProfileSnapshotDigest: 'snapshot-digest',
    unknownAt: null, unknownReason: null, state: 'pending', fenceQuarantined: false,
    latestAttempt: {
      connectionEpoch: 'old-epoch', rpcId: 4,
      childWriteAttemptedAt: '2026-08-07T00:00:00.000Z', childWriteConfirmedAt: null,
      unresolvedReason: 'connection_closed', responseKind: null,
    },
  })
  assert.equal(dispatches, 0)
  assert.equal(unknown.length, 1)
  assert.equal(unknown[0].reason, 'dispatch_may_have_reached_child')
})

test('boot recovery makes an ambiguous claimed turn durably unknown instead of escaping', async () => {
  const unknown: Array<Record<string, unknown>> = []
  const repository = {
    recordManualCompactionUnknown(input: Record<string, unknown>) { unknown.push(input) },
  } as unknown as CodexBindingRepository
  const session = {
    getClient: () => ({
      async threadRead() {
        return {
          thread: {
            id: 'thread-1',
            turns: [
              { id: 'compact-turn-1', status: 'completed', error: null, items: [] },
              { id: 'compact-turn-1', status: 'completed', error: null, items: [] },
            ],
          },
        }
      },
    }),
  } as unknown as CodexSidecarSession
  const controller = new CodexManualCompactionController({
    repository,
    gatewayRepository: {} as CodexModelGatewayRepository,
    getSession: () => session,
    ensureThreadLoaded: async () => undefined,
    ownerMainBootId: 'new-main', timeoutMs: 20_000,
    now: () => '2026-08-07T00:00:00.000Z', nowMs: () => 1_000,
  })
  await controller.reconcileRecovery({
    manualCompactionId: 'manual-1', threadBindingId: 'binding-1', codexThreadId: 'thread-1',
    codexCompactionTurnId: 'compact-turn-1', preDispatchThreadReadDigest: 'pre-read',
    preDispatchTurnIds: [], aliasId: 'alias-1', aliasGeneration: 1,
    upstreamProfileSnapshotDigest: 'snapshot-digest', unknownAt: null, unknownReason: null,
    state: 'pending', fenceQuarantined: false, latestAttempt: null,
  })
  assert.equal(unknown.length, 1)
  assert.match(String(unknown[0].reason), /claimed_turn_readback_failed:manual_recovery_turn_readback_ambiguous/)
})

test('boot recovery validates a claimed turn once, then observes its terminal state in the background', async () => {
  let status: 'inProgress' | 'completed' = 'inProgress'
  let reads = 0
  let consumed = 0
  let releasePoll!: () => void
  const poll = new Promise<void>((resolve) => { releasePoll = resolve })
  const recovery = {
    manualCompactionId: 'manual-background', threadBindingId: 'binding-1',
    codexThreadId: 'thread-1', codexCompactionTurnId: 'compact-turn-1',
    preDispatchThreadReadDigest: 'pre-read', preDispatchTurnIds: [],
    aliasId: 'alias-1', aliasGeneration: 1,
    upstreamProfileSnapshotDigest: 'snapshot-digest', unknownAt: null,
    unknownReason: null, state: 'pending' as const, fenceQuarantined: false,
    latestAttempt: null,
  }
  const controller = new CodexManualCompactionController({
    repository: {
      consumeManualCompaction() { consumed += 1 },
      recordManualCompactionUnknown() { throw new Error('unexpected_unknown') },
    } as unknown as CodexBindingRepository,
    gatewayRepository: {
      readManualCompactionGatewayEvidence: () => ({
        receiptId: 'gateway-receipt',
        upstreamProfileSnapshotDigest: 'snapshot-digest',
        toolsDigest: digestCanonicalJson([]),
        toolCount: 0,
        requestEvidenceDigest: 'request-evidence',
        responseEvidenceDigest: 'response-evidence',
      }),
    } as unknown as CodexModelGatewayRepository,
    getSession: () => ({
      getClient: () => ({
        async threadRead() {
          reads += 1
          return {
            thread: {
              id: 'thread-1',
              turns: [{
                id: 'compact-turn-1', status, error: null,
                items: status === 'completed'
                  ? [{ type: 'contextCompaction', id: 'compact-item-1' }]
                  : [],
              }],
            },
          }
        },
      }),
    }) as unknown as CodexSidecarSession,
    ensureThreadLoaded: async () => undefined,
    ownerMainBootId: 'main-1', timeoutMs: 300_000,
    now: () => '2026-08-11T00:00:00.000Z', nowMs: () => 0,
    wait: () => poll,
  })

  assert.equal(await controller.reconcileRecovery(recovery), 'observing')
  assert.equal(reads, 1)
  assert.equal(consumed, 0)
  status = 'completed'
  releasePoll()
  await waitFor(() => consumed === 1)
  assert.equal(reads, 2)
})

test('sidecar generation change cancels a manual observer without retiring it as unknown', async () => {
  let status: 'inProgress' | 'completed' = 'inProgress'
  let consumed = 0
  let unknown = 0
  const recovery = {
    manualCompactionId: 'manual-generation', threadBindingId: 'binding-1',
    codexThreadId: 'thread-1', codexCompactionTurnId: 'compact-turn-1',
    preDispatchThreadReadDigest: 'pre-read', preDispatchTurnIds: [],
    aliasId: 'alias-1', aliasGeneration: 1,
    upstreamProfileSnapshotDigest: 'snapshot-digest', unknownAt: null,
    unknownReason: null, state: 'pending' as const, fenceQuarantined: false,
    latestAttempt: null,
  }
  const controller = new CodexManualCompactionController({
    repository: {
      consumeManualCompaction() { consumed += 1 },
      recordManualCompactionUnknown() { unknown += 1 },
    } as unknown as CodexBindingRepository,
    gatewayRepository: {
      readManualCompactionGatewayEvidence: () => ({
        receiptId: 'gateway-receipt',
        upstreamProfileSnapshotDigest: 'snapshot-digest',
        toolsDigest: digestCanonicalJson([]),
        toolCount: 0,
        requestEvidenceDigest: 'request-evidence',
        responseEvidenceDigest: 'response-evidence',
      }),
    } as unknown as CodexModelGatewayRepository,
    getSession: () => ({
      getClient: () => ({
        async threadRead() {
          return {
            thread: {
              id: 'thread-1',
              turns: [{
                id: 'compact-turn-1', status, error: null,
                items: status === 'completed'
                  ? [{ type: 'contextCompaction', id: 'compact-item-1' }]
                  : [],
              }],
            },
          }
        },
      }),
    }) as unknown as CodexSidecarSession,
    ensureThreadLoaded: async () => undefined,
    ownerMainBootId: 'main-1', timeoutMs: 300_000,
    now: () => '2026-08-11T00:00:00.000Z', nowMs: () => 0,
    wait: () => new Promise<void>(() => undefined),
  })

  assert.equal(await controller.reconcileRecovery(recovery), 'observing')
  assert.equal(await controller.beginBootGeneration(), true)
  assert.equal(consumed, 0)
  assert.equal(unknown, 0)
  status = 'completed'
  assert.equal(await controller.reconcileRecovery(recovery), 'settled')
  assert.equal(consumed, 1)
  assert.equal(unknown, 0)
})

test('a proven-absent redispatch retries in the same generation before any child write', async () => {
  let dispatches = 0
  let consumed = 0
  const failures: string[] = []
  const repository = {
    renewManualCompactionRecoveryWindow() {},
    readRecoverySnapshot: () => ({ manualCompactions: [] }),
    consumeManualCompaction() { consumed += 1 },
  } as unknown as CodexBindingRepository
  const inboundBuffer = {
    registerProvisionalManualCompaction() {},
    readManualCompactionEvidence: () => ({
      turnId: 'compact-turn-1',
      contextCompactionItemId: 'compact-notification-1',
      terminalStatus: 'completed',
    }),
    async reconcileTurn(_identity: unknown, commit: () => void) {
      commit()
      return 'released' as const
    },
  }
  const controller = new CodexManualCompactionController({
    repository,
    gatewayRepository: {
      readManualCompactionGatewayEvidence: () => ({
        receiptId: 'gateway-receipt',
        upstreamProfileSnapshotDigest: 'snapshot-digest',
        toolsDigest: digestCanonicalJson([]),
        toolCount: 0,
        requestEvidenceDigest: 'request-evidence',
        responseEvidenceDigest: 'response-evidence',
      }),
    } as unknown as CodexModelGatewayRepository,
    getSession: () => ({
      getActiveConnectionEpoch: () => 'connection-1',
      getInboundBuffer: () => inboundBuffer,
      isConnectionLive: () => true,
      getClient: () => ({
        async threadCompactStart() {
          dispatches += 1
          if (dispatches === 1) throw new Error('SQLITE_BUSY')
        },
        async threadRead() {
          return {
            thread: {
              id: 'thread-1',
              turns: [{
                id: 'compact-turn-1', status: 'completed', error: null,
                items: [{ type: 'contextCompaction', id: 'compact-readback-1' }],
              }],
            },
          }
        },
      }),
    }) as unknown as CodexSidecarSession,
    ensureThreadLoaded: async () => undefined,
    ownerMainBootId: 'main-1', timeoutMs: 300_000,
    now: () => '2026-08-11T00:00:00.000Z', nowMs: () => 0,
    wait: async () => undefined,
    onRecoveryFailure({ reason }) { failures.push(reason) },
  })

  assert.equal(await controller.reconcileRecovery({
    manualCompactionId: 'manual-retry', threadBindingId: 'binding-1',
    codexThreadId: 'thread-1', codexCompactionTurnId: null,
    preDispatchThreadReadDigest: 'pre-read', preDispatchTurnIds: [],
    aliasId: 'alias-1', aliasGeneration: 1,
    upstreamProfileSnapshotDigest: 'snapshot-digest', unknownAt: null,
    unknownReason: null, state: 'pending', fenceQuarantined: false,
    latestAttempt: null,
  }), 'observing')
  await waitFor(() => consumed === 1)
  assert.equal(dispatches, 2)
  assert.deepEqual(failures, ['SQLITE_BUSY'])
})

test('a deterministic redispatch identity failure becomes explicit unknown without spinning', async () => {
  let dispatches = 0
  let unknownReason: string | null = null
  const controller = new CodexManualCompactionController({
    repository: {
      renewManualCompactionRecoveryWindow() {},
      readRecoverySnapshot: () => ({ manualCompactions: [] }),
      recordManualCompactionUnknown(input: { reason: string }) {
        unknownReason = input.reason
      },
    } as unknown as CodexBindingRepository,
    gatewayRepository: {} as CodexModelGatewayRepository,
    getSession: () => ({
      getActiveConnectionEpoch: () => 'connection-1',
      getInboundBuffer: () => ({ registerProvisionalManualCompaction() {} }),
      getClient: () => ({
        async threadCompactStart() {
          dispatches += 1
          throw new Error('manual_dispatch_binding_not_unique')
        },
      }),
    }) as unknown as CodexSidecarSession,
    ensureThreadLoaded: async () => undefined,
    ownerMainBootId: 'main-1', timeoutMs: 300_000,
    now: () => '2026-08-11T00:00:00.000Z', nowMs: () => 0,
    wait: async () => undefined,
  })

  assert.equal(await controller.reconcileRecovery({
    manualCompactionId: 'manual-deterministic', threadBindingId: 'binding-1',
    codexThreadId: 'thread-1', codexCompactionTurnId: null,
    preDispatchThreadReadDigest: 'pre-read', preDispatchTurnIds: [],
    aliasId: 'alias-1', aliasGeneration: 1,
    upstreamProfileSnapshotDigest: 'snapshot-digest', unknownAt: null,
    unknownReason: null, state: 'pending', fenceQuarantined: false,
    latestAttempt: null,
  }), 'observing')
  await waitFor(() => unknownReason !== null)
  assert.equal(dispatches, 1)
  assert.equal(unknownReason, 'redispatch_failed:manual_dispatch_binding_not_unique')
})

// 2026-10-07: compaction on a thread not loaded after restart was answered “thread not found”; the record stayed
// pending with its fence, and boot recovery later called it unknown, so the conversation could only be reset.
test('a rejected compaction is settled from unchanged readback, live and at boot, never redispatched', async () => {
  const recovery = (overrides: Partial<CodexManualCompactionRecovery> = {}): CodexManualCompactionRecovery => ({
    manualCompactionId: 'manual-1', threadBindingId: 'binding-1', codexThreadId: 'thread-1',
    codexCompactionTurnId: null, preDispatchThreadReadDigest: 'pre-read', preDispatchTurnIds: ['turn-a', 'turn-b'],
    aliasId: 'alias-1', aliasGeneration: 1, upstreamProfileSnapshotDigest: 'snapshot-digest',
    unknownAt: null, unknownReason: null, state: 'pending', fenceQuarantined: false,
    latestAttempt: {
      connectionEpoch: 'old-epoch', rpcId: 5, childWriteAttemptedAt: '2026-10-06T17:29:15.619Z',
      childWriteConfirmedAt: '2026-10-06T17:29:15.619Z', unresolvedReason: null, responseKind: 'rejected',
    },
    ...overrides,
  })
  const harness = (turnIds: string[]) => {
    const calls: string[] = []
    const repository = {
      settleRejectedManualCompaction(input: { manualCompactionId: string }) {
        calls.push(`settle:${input.manualCompactionId}`)
      },
      recordManualCompactionUnknown(input: { reason: string }) { calls.push(`unknown:${input.reason}`) },
      readManualCompactionRoute: () => ({
        threadBindingId: 'binding-1', codexThreadId: 'thread-1', codexModel: 'ready-e0-model',
        upstreamProfileSnapshotRef: 'snapshot-ref', upstreamProfileSnapshotDigest: 'snapshot-digest',
      }),
      beginManualCompaction: (input: { manualCompactionId: string }) => ({
        manualCompactionId: input.manualCompactionId, codexThreadId: 'thread-1',
      }),
    } as unknown as CodexBindingRepository
    const session = {
      getActiveConnectionEpoch: () => 'epoch-1',
      isConnectionLive: () => true,
      getInboundBuffer: () => ({
        registerProvisionalManualCompaction() { calls.push('register') },
        discardRejectedManualCompaction(input: { manualCompactionId: string }) {
          calls.push(`discard:${input.manualCompactionId}`)
        },
      }),
      getClient: () => ({
        async threadCompactStart() { calls.push('dispatch') },
        async threadRead() {
          calls.push('readback')
          return { thread: { id: 'thread-1', turns: turnIds.map((id) => ({ id, status: 'completed', items: [] })) } }
        },
      }),
    } as unknown as CodexSidecarSession
    const controller = new CodexManualCompactionController({
      repository,
      gatewayRepository: {
        readSnapshot: () => ({ credentialReferenceId: 'credential-1' }),
      } as unknown as CodexModelGatewayRepository,
      getSession: () => session,
      ensureThreadLoaded: async () => { calls.push('ensure-loaded') },
      ownerMainBootId: 'main-1', timeoutMs: 20_000,
      now: () => '2026-10-07T00:00:00.000Z', nowMs: () => 1_000,
      wait: async () => undefined,
    })
    return { controller, calls }
  }

  {
    const { controller, calls } = harness(['turn-a', 'turn-b'])
    assert.equal(await controller.reconcileRecovery(recovery()), 'settled')
    assert.deepEqual(calls, ['readback', 'readback', 'settle:manual-1'])
  }
  {
    const { controller, calls } = harness(['turn-a', 'turn-b'])
    assert.equal(await controller.reconcileRecovery(recovery({
      unknownAt: '2026-10-06T17:34:17.491Z', unknownReason: 'dispatch_may_have_reached_child',
    })), 'settled')
    assert.deepEqual(calls, ['readback', 'readback', 'settle:manual-1'], 'the record already called unknown is repaired')
  }
  {
    const { controller, calls } = harness(['turn-a', 'turn-b', 'turn-new'])
    assert.equal(await controller.reconcileRecovery(recovery()), 'settled')
    assert.deepEqual(calls, ['readback', 'unknown:rejected_dispatch_unproven'], 'a new turn means it may have run')
  }
  {
    const { controller, calls } = harness(['turn-a', 'turn-b'])
    const live = await controller.begin({ aliasId: 'alias-1', aliasGeneration: 1 })
    assert.equal(await controller.settleRejected({ identity: { aliasId: 'alias-1', aliasGeneration: 1 },
      manualCompactionId: live.manualCompactionId }), true)
    assert.deepEqual(calls, ['readback', 'register', 'readback', 'readback',
      `discard:${live.manualCompactionId}`, `settle:${live.manualCompactionId}`])
  }
})

// A second compaction right after one would summarize an empty history without the thread's instructions.
test('manual compaction is refused when nothing happened since the last compaction', async () => {
  let begun = 0
  const controller = new CodexManualCompactionController({
    repository: {
      readManualCompactionRoute: () => ({
        threadBindingId: 'binding-1', codexThreadId: 'thread-1', codexModel: 'ready-e0-model',
        upstreamProfileSnapshotRef: 'snapshot-ref', upstreamProfileSnapshotDigest: 'snapshot-digest',
      }),
      beginManualCompaction() { begun += 1 },
    } as unknown as CodexBindingRepository,
    gatewayRepository: {
      readSnapshot: () => ({ credentialReferenceId: 'credential-1' }),
    } as unknown as CodexModelGatewayRepository,
    getSession: () => ({
      getActiveConnectionEpoch: () => 'epoch-1',
      getInboundBuffer: () => ({}),
      getClient: () => ({
        async threadRead() {
          return { thread: { id: 'thread-1', turns: [
            { id: 'turn-a', status: 'completed', items: [{ type: 'userMessage', id: 'u' }] },
            { id: 'turn-compact', status: 'completed', items: [{ type: 'contextCompaction', id: 'c' }] },
          ] } }
        },
      }),
    }) as unknown as CodexSidecarSession,
    ensureThreadLoaded: async () => undefined,
    ownerMainBootId: 'main-1', timeoutMs: 20_000,
    now: () => '2026-10-07T00:00:00.000Z', nowMs: () => 1_000,
  })
  await assert.rejects(controller.begin({ aliasId: 'alias-1', aliasGeneration: 1 }),
    (error: { code?: string }) => error.code === 'no_active_operation')
  assert.equal(begun, 0)
})
