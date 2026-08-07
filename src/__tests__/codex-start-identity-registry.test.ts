import assert from 'node:assert/strict'
import test from 'node:test'

import { CodexStartIdentityRegistry } from '../main/modules/agent-control/codex-runtime/codex-start-identity-registry'

test('reservation capacity is all-or-none for lazy roots', () => {
  const registry = new CodexStartIdentityRegistry({ capacity: 64 })
  for (let index = 0; index < 63; index += 1) {
    const result = registry.reserve({ scopeId: `scope-${index}`, existingThread: true })
    assert.equal(result.ok, true)
  }
  const lazy = registry.reserve({ scopeId: 'scope-lazy', existingThread: false })
  assert.deepEqual(lazy, {
    ok: false,
    code: 'start_identity_capacity_exhausted',
    retryableByUser: true,
    error: 'codex_start_identity_capacity_exhausted',
    admissionEvidenceDigest: lazy.ok ? '' : lazy.admissionEvidenceDigest,
  })
  assert.equal(registry.snapshot().capacityCharged, 63)
  assert.equal(registry.reserve({ scopeId: 'scope-last', existingThread: true }).ok, true)
  assert.equal(registry.snapshot().capacityCharged, 64)
})

test('accepted lazy-root identities release capacity and leave only response guards', () => {
  const registry = new CodexStartIdentityRegistry({ capacity: 64 })
  const reserved = registry.reserve({ scopeId: 'scope-lazy', existingThread: false })
  assert.equal(reserved.ok, true)
  if (!reserved.ok) return
  const [threadMember, turnMember] = reserved.reservation.members

  registry.activate({
    reservationSetId: reserved.reservation.reservationSetId,
    reservationId: threadMember.reservationId,
    bindingId: 'thread-binding-1',
    connectionEpoch: 'epoch-1',
    rpcId: 1,
  })
  registry.markConnectionClosed('epoch-1')
  assert.equal(
    registry.snapshot().members.find((member) => (
      member.reservationId === threadMember.reservationId
    ))?.state,
    'recovery_held',
  )

  registry.reconcileAccepted({
    connectionEpoch: 'epoch-1',
    rpcId: 1,
    method: 'thread/start',
    bindingId: 'thread-binding-1',
    nativeId: 'thread-native-1',
    responsePending: false,
  })
  assert.equal(registry.snapshot().capacityCharged, 1)
  assert.equal(registry.snapshot().lateResponseGuards.length, 0)
  assert.equal(registry.snapshot().members[0]?.reservationId, turnMember.reservationId)

  registry.activate({
    reservationSetId: reserved.reservation.reservationSetId,
    reservationId: turnMember.reservationId,
    bindingId: 'ready-run-1',
    connectionEpoch: 'epoch-2',
    rpcId: 2,
  })
  registry.reconcileAccepted({
    connectionEpoch: 'epoch-2',
    rpcId: 2,
    method: 'turn/start',
    bindingId: 'ready-run-1',
    nativeId: 'turn-native-1',
    responsePending: true,
  })
  assert.equal(registry.snapshot().capacityCharged, 0)
  assert.equal(registry.snapshot().lateResponseGuards.length, 1)

  assert.throws(
    () => registry.closeLateResponseGuard({
      connectionEpoch: 'epoch-2',
      rpcId: 2,
      method: 'turn/start',
      bindingId: 'ready-run-1',
      nativeId: 'different-turn',
      reason: 'response_received',
    }),
    /late_response_guard_identity_mismatch/,
  )
  registry.closeLateResponseGuard({
    connectionEpoch: 'epoch-2',
    rpcId: 2,
    method: 'turn/start',
    bindingId: 'ready-run-1',
    nativeId: 'turn-native-1',
    reason: 'response_received',
  })
  assert.equal(registry.snapshot().lateResponseGuards.length, 0)
})

test('connection close removes matching late-response guards but keeps unrelated guards', () => {
  const registry = new CodexStartIdentityRegistry({ capacity: 64 })
  for (const [index, epoch] of ['epoch-close', 'epoch-live'].entries()) {
    const reserved = registry.reserve({ scopeId: `scope-${index}`, existingThread: true })
    assert.equal(reserved.ok, true)
    if (!reserved.ok) continue
    registry.activate({
      reservationSetId: reserved.reservation.reservationSetId,
      reservationId: reserved.reservation.members[0].reservationId,
      bindingId: `run-${index}`,
      connectionEpoch: epoch,
      rpcId: index + 1,
    })
    registry.reconcileAccepted({
      connectionEpoch: epoch,
      rpcId: index + 1,
      method: 'turn/start',
      bindingId: `run-${index}`,
      nativeId: `turn-${index}`,
      responsePending: true,
    })
  }
  assert.equal(registry.snapshot().lateResponseGuards.length, 2)
  registry.markConnectionClosed('epoch-close')
  assert.deepEqual(
    registry.snapshot().lateResponseGuards.map((guard) => guard.connectionEpoch),
    ['epoch-live'],
  )
})

test('pre-dispatch release rejects any reservation set with an activated member', () => {
  const registry = new CodexStartIdentityRegistry({ capacity: 64 })
  const held = registry.reserve({ scopeId: 'scope-held', existingThread: true })
  assert.equal(held.ok, true)
  if (!held.ok) return
  registry.releaseBeforeDispatch({
    reservationSetId: held.reservation.reservationSetId,
    evidenceDigest: 'ingress-failed-digest',
  })
  assert.equal(registry.snapshot().capacityCharged, 0)

  const active = registry.reserve({ scopeId: 'scope-active', existingThread: true })
  assert.equal(active.ok, true)
  if (!active.ok) return
  registry.activate({
    reservationSetId: active.reservation.reservationSetId,
    reservationId: active.reservation.members[0].reservationId,
    bindingId: 'run-active',
    connectionEpoch: 'epoch-active',
    rpcId: 9,
  })
  assert.throws(
    () => registry.releaseBeforeDispatch({
      reservationSetId: active.reservation.reservationSetId,
      evidenceDigest: 'must-not-release',
    }),
    /reservation_already_dispatched/,
  )
  assert.equal(registry.snapshot().capacityCharged, 1)
})

test('unresolved start identities have no timeout eviction and duplicate rpc identities fail closed', () => {
  const registry = new CodexStartIdentityRegistry({ capacity: 64 })
  for (let index = 0; index < 64; index += 1) {
    const reserved = registry.reserve({ scopeId: `scope-${index}`, existingThread: true })
    assert.equal(reserved.ok, true)
    if (!reserved.ok) continue
    registry.activate({
      reservationSetId: reserved.reservation.reservationSetId,
      reservationId: reserved.reservation.members[0].reservationId,
      bindingId: `run-${index}`,
      connectionEpoch: 'epoch-full',
      rpcId: index + 1,
    })
  }
  registry.markConnectionClosed('epoch-full')
  assert.equal(registry.snapshot().capacityCharged, 64)
  assert.equal(registry.snapshot().members.every((member) => member.state === 'recovery_held'), true)
  assert.equal(registry.reserve({ scopeId: 'overflow', existingThread: true }).ok, false)

  const duplicate = new CodexStartIdentityRegistry({ capacity: 64 })
  const first = duplicate.reserve({ scopeId: 'scope-a', existingThread: true })
  const second = duplicate.reserve({ scopeId: 'scope-b', existingThread: true })
  assert.equal(first.ok && second.ok, true)
  if (!first.ok || !second.ok) return
  duplicate.activate({
    reservationSetId: first.reservation.reservationSetId,
    reservationId: first.reservation.members[0].reservationId,
    bindingId: 'run-a',
    connectionEpoch: 'epoch-duplicate',
    rpcId: 1,
  })
  assert.throws(
    () => duplicate.activate({
      reservationSetId: second.reservation.reservationSetId,
      reservationId: second.reservation.members[0].reservationId,
      bindingId: 'run-b',
      connectionEpoch: 'epoch-duplicate',
      rpcId: 1,
    }),
    /rpc_identity_conflict/,
  )
})

test('boot restore rebuilds held, recovery-held, and non-capacity guards without eviction', () => {
  const registry = new CodexStartIdentityRegistry({ capacity: 4 })
  registry.restore({
    capacity: 4,
    capacityCharged: 2,
    members: [
      {
        reservationSetId: 'set-lazy', reservationId: 'member-turn', scopeId: 'scope-1',
        method: 'turn/start', requiredMemberCount: 2, state: 'held', bindingId: 'run-1',
        connectionEpoch: null, rpcId: null,
      },
      {
        reservationSetId: 'set-existing', reservationId: 'member-pending', scopeId: 'scope-2',
        method: 'turn/start', requiredMemberCount: 1, state: 'recovery_held', bindingId: 'run-2',
        connectionEpoch: 'epoch-old', rpcId: 9,
      },
    ],
    lateResponseGuards: [{
      connectionEpoch: 'epoch-old', rpcId: 8, method: 'thread/start',
      bindingId: 'thread-binding-1', nativeId: 'thread-native-1',
    }],
  })
  assert.equal(registry.snapshot().capacityCharged, 2)
  assert.equal(registry.snapshot().lateResponseGuards.length, 1)
  registry.reconcileAccepted({
    connectionEpoch: 'epoch-old', rpcId: 9, method: 'turn/start', bindingId: 'run-2',
    nativeId: 'turn-native-2', responsePending: false,
  })
  assert.equal(registry.snapshot().capacityCharged, 1)
})

test('boot restore rejects overflow, malformed reservation sets, and rpc collisions', () => {
  const member = {
    reservationSetId: 'set-1', reservationId: 'member-1', scopeId: 'scope-1',
    method: 'turn/start' as const, requiredMemberCount: 1 as const,
    state: 'recovery_held' as const, bindingId: 'run-1', connectionEpoch: 'epoch-1', rpcId: 1,
  }
  assert.throws(
    () => new CodexStartIdentityRegistry({ capacity: 1 }).restore({
      capacity: 1,
      capacityCharged: 2,
      members: [member, { ...member, reservationSetId: 'set-2', reservationId: 'member-2', rpcId: 2 }],
      lateResponseGuards: [],
    }),
    /start_identity_capacity_recovery_overflow/,
  )
  assert.throws(
    () => new CodexStartIdentityRegistry({ capacity: 4 }).restore({
      capacity: 4,
      capacityCharged: 1,
      members: [{ ...member, requiredMemberCount: 2, method: 'thread/start' as never }],
      lateResponseGuards: [],
    }),
    /registry_restore_set_invalid/,
  )
  assert.throws(
    () => new CodexStartIdentityRegistry({ capacity: 4 }).restore({
      capacity: 4,
      capacityCharged: 1,
      members: [member],
      lateResponseGuards: [{
        connectionEpoch: 'epoch-1', rpcId: 1, method: 'turn/start',
        bindingId: 'run-guard', nativeId: 'turn-guard',
      }],
    }),
    /registry_restore_rpc_conflict/,
  )
})
