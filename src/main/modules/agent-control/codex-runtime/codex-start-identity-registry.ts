import { createHash, randomUUID } from 'node:crypto'

import type {
  StartIdentityReservationResult,
  StartIdentityReservationSet,
} from '../send-scoped-confirmation'
import type { VerifiedCodexRuntime } from './codex-runtime-host'

type StartMethod = 'thread/start' | 'turn/start'
type CapacityState = 'held' | 'pending' | 'recovery_held'

type RegistryMember = {
  reservationSetId: string
  reservationId: string
  scopeId: string
  method: StartMethod
  requiredMemberCount: 1 | 2
  state: CapacityState
  bindingId: string | null
  connectionEpoch: string | null
  rpcId: number | null
}

type LateResponseGuard = {
  connectionEpoch: string
  rpcId: number
  method: StartMethod
  bindingId: string
  nativeId: string
}

export type CodexStartIdentityRegistrySnapshot = {
  capacity: number
  capacityCharged: number
  members: RegistryMember[]
  lateResponseGuards: LateResponseGuard[]
}

export type CodexStartIdentityRegistryRestoreSnapshot = CodexStartIdentityRegistrySnapshot

export class CodexStartIdentityRegistryError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'CodexStartIdentityRegistryError'
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function requireIdentity(value: string, code: string): void {
  if (!value.trim()) throw new CodexStartIdentityRegistryError(code)
}

function rpcKey(connectionEpoch: string, rpcId: number): string {
  return `${connectionEpoch}\0${rpcId}`
}

function cloneMember(member: RegistryMember): RegistryMember {
  return { ...member }
}

export class CodexStartIdentityRegistry {
  private readonly members = new Map<string, RegistryMember>()
  private readonly reservationSets = new Map<string, string[]>()
  private readonly activeRpcMembers = new Map<string, string>()
  private readonly guards = new Map<string, LateResponseGuard>()

  constructor(private readonly options: { capacity: number }) {
    if (!Number.isSafeInteger(options.capacity) || options.capacity <= 0) {
      throw new CodexStartIdentityRegistryError('registry_capacity_invalid')
    }
  }

  reserve(input: {
    scopeId: string
    existingThread: boolean
  }): StartIdentityReservationResult {
    requireIdentity(input.scopeId, 'reservation_scope_invalid')
    const methods: StartMethod[] = input.existingThread
      ? ['turn/start']
      : ['thread/start', 'turn/start']
    if (this.members.size + methods.length > this.options.capacity) {
      return {
        ok: false,
        code: 'start_identity_capacity_exhausted',
        retryableByUser: true,
        error: 'codex_start_identity_capacity_exhausted',
        admissionEvidenceDigest: sha256(JSON.stringify({
          code: 'start_identity_capacity_exhausted',
          capacity: this.options.capacity,
          capacityCharged: this.members.size,
          required: methods.length,
        })),
      }
    }

    const reservationSetId = randomUUID()
    const records = methods.map((method): RegistryMember => ({
      reservationSetId,
      reservationId: randomUUID(),
      scopeId: input.scopeId,
      method,
      requiredMemberCount: methods.length as 1 | 2,
      state: 'held',
      bindingId: null,
      connectionEpoch: null,
      rpcId: null,
    }))
    for (const record of records) this.members.set(record.reservationId, record)
    this.reservationSets.set(reservationSetId, records.map((record) => record.reservationId))
    const reservationEvidenceDigest = sha256(JSON.stringify({
      reservationSetId,
      scopeId: input.scopeId,
      methods,
      reservationIds: records.map((record) => record.reservationId),
    }))

    if (input.existingThread) {
      const reservation: StartIdentityReservationSet = {
        reservationSetId,
        scopeId: input.scopeId,
        existingThread: true,
        members: [{ method: 'turn/start', reservationId: records[0].reservationId }],
        reservationEvidenceDigest,
      }
      return { ok: true, reservation }
    }
    const reservation: StartIdentityReservationSet = {
      reservationSetId,
      scopeId: input.scopeId,
      existingThread: false,
      members: [
        { method: 'thread/start', reservationId: records[0].reservationId },
        { method: 'turn/start', reservationId: records[1].reservationId },
      ],
      reservationEvidenceDigest,
    }
    return { ok: true, reservation }
  }

  restore(snapshot: CodexStartIdentityRegistryRestoreSnapshot): void {
    if (this.members.size || this.reservationSets.size || this.activeRpcMembers.size || this.guards.size) {
      throw new CodexStartIdentityRegistryError('registry_restore_requires_empty')
    }
    if (snapshot.capacity !== this.options.capacity) {
      throw new CodexStartIdentityRegistryError('registry_restore_capacity_mismatch')
    }
    if (snapshot.capacityCharged !== snapshot.members.length) {
      throw new CodexStartIdentityRegistryError('registry_restore_charge_mismatch')
    }
    if (snapshot.members.length > this.options.capacity) {
      throw new CodexStartIdentityRegistryError('start_identity_capacity_recovery_overflow')
    }

    const sets = new Map<string, RegistryMember[]>()
    for (const raw of snapshot.members) {
      const member = cloneMember(raw)
      requireIdentity(member.reservationSetId, 'registry_restore_set_invalid')
      requireIdentity(member.reservationId, 'registry_restore_member_invalid')
      requireIdentity(member.scopeId, 'registry_restore_scope_invalid')
      requireIdentity(member.bindingId || '', 'registry_restore_binding_invalid')
      if (
        (member.requiredMemberCount !== 1 && member.requiredMemberCount !== 2)
        || (member.state !== 'held' && member.state !== 'pending' && member.state !== 'recovery_held')
        || (member.method !== 'thread/start' && member.method !== 'turn/start')
        || this.members.has(member.reservationId)
      ) throw new CodexStartIdentityRegistryError('registry_restore_member_invalid')
      if (member.state === 'held') {
        if (member.connectionEpoch !== null || member.rpcId !== null) {
          throw new CodexStartIdentityRegistryError('registry_restore_held_rpc_invalid')
        }
      } else {
        if (
          !member.connectionEpoch
          || !Number.isSafeInteger(member.rpcId)
          || (member.rpcId as number) <= 0
        ) throw new CodexStartIdentityRegistryError('registry_restore_pending_rpc_invalid')
        const key = rpcKey(member.connectionEpoch, member.rpcId as number)
        if (this.activeRpcMembers.has(key)) {
          throw new CodexStartIdentityRegistryError('registry_restore_rpc_conflict')
        }
        this.activeRpcMembers.set(key, member.reservationId)
      }
      this.members.set(member.reservationId, member)
      const group = sets.get(member.reservationSetId) || []
      group.push(member)
      sets.set(member.reservationSetId, group)
    }
    for (const [reservationSetId, group] of sets) {
      const requiredCounts = new Set(group.map((member) => member.requiredMemberCount))
      const scopes = new Set(group.map((member) => member.scopeId))
      const methods = group.map((member) => member.method).sort()
      const requiredCount = group[0]?.requiredMemberCount
      const valid = requiredCounts.size === 1
        && scopes.size === 1
        && (
          (requiredCount === 1 && group.length === 1 && methods[0] === 'turn/start')
          || (
            requiredCount === 2
            && (
              (group.length === 2 && methods[0] === 'thread/start' && methods[1] === 'turn/start')
              || (group.length === 1 && methods[0] === 'turn/start')
            )
          )
        )
      if (!valid) throw new CodexStartIdentityRegistryError('registry_restore_set_invalid')
      this.reservationSets.set(reservationSetId, group.map((member) => member.reservationId))
    }

    for (const raw of snapshot.lateResponseGuards) {
      const guard = { ...raw }
      requireIdentity(guard.connectionEpoch, 'registry_restore_guard_invalid')
      requireIdentity(guard.bindingId, 'registry_restore_guard_invalid')
      requireIdentity(guard.nativeId, 'registry_restore_guard_invalid')
      if (!Number.isSafeInteger(guard.rpcId) || guard.rpcId <= 0) {
        throw new CodexStartIdentityRegistryError('registry_restore_guard_invalid')
      }
      const key = rpcKey(guard.connectionEpoch, guard.rpcId)
      if (this.activeRpcMembers.has(key) || this.guards.has(key)) {
        throw new CodexStartIdentityRegistryError('registry_restore_rpc_conflict')
      }
      this.guards.set(key, guard)
    }
  }

  activate(input: {
    reservationSetId: string
    reservationId: string
    bindingId: string
    connectionEpoch: string
    rpcId: number
  }): void {
    requireIdentity(input.bindingId, 'binding_identity_invalid')
    requireIdentity(input.connectionEpoch, 'connection_epoch_invalid')
    if (!Number.isSafeInteger(input.rpcId) || input.rpcId <= 0) {
      throw new CodexStartIdentityRegistryError('rpc_identity_invalid')
    }
    const member = this.members.get(input.reservationId)
    if (!member || member.reservationSetId !== input.reservationSetId) {
      throw new CodexStartIdentityRegistryError('reservation_member_not_found')
    }
    if (member.state !== 'held') {
      throw new CodexStartIdentityRegistryError('reservation_member_not_held')
    }
    const key = rpcKey(input.connectionEpoch, input.rpcId)
    if (this.activeRpcMembers.has(key) || this.guards.has(key)) {
      throw new CodexStartIdentityRegistryError('rpc_identity_conflict')
    }
    member.state = 'pending'
    member.bindingId = input.bindingId
    member.connectionEpoch = input.connectionEpoch
    member.rpcId = input.rpcId
    this.activeRpcMembers.set(key, member.reservationId)
  }

  markConnectionClosed(connectionEpoch: string): void {
    requireIdentity(connectionEpoch, 'connection_epoch_invalid')
    for (const member of this.members.values()) {
      if (member.connectionEpoch === connectionEpoch && member.state === 'pending') {
        member.state = 'recovery_held'
      }
    }
    for (const [key, guard] of this.guards) {
      if (guard.connectionEpoch === connectionEpoch) this.guards.delete(key)
    }
  }

  reconcileAccepted(input: {
    connectionEpoch: string
    rpcId: number
    method: StartMethod
    bindingId: string
    nativeId: string
    responsePending: boolean
  }): void {
    const key = rpcKey(input.connectionEpoch, input.rpcId)
    const reservationId = this.activeRpcMembers.get(key)
    const member = reservationId ? this.members.get(reservationId) : null
    if (!member) throw new CodexStartIdentityRegistryError('unresolved_start_not_found')
    if (
      member.method !== input.method
      || member.bindingId !== input.bindingId
      || member.connectionEpoch !== input.connectionEpoch
      || member.rpcId !== input.rpcId
      || (member.state !== 'pending' && member.state !== 'recovery_held')
    ) throw new CodexStartIdentityRegistryError('unresolved_start_identity_mismatch')
    requireIdentity(input.nativeId, 'native_identity_invalid')

    this.activeRpcMembers.delete(key)
    this.members.delete(member.reservationId)
    const setMembers = this.reservationSets.get(member.reservationSetId)
    if (setMembers) {
      const remaining = setMembers.filter((id) => id !== member.reservationId)
      if (remaining.length > 0) this.reservationSets.set(member.reservationSetId, remaining)
      else this.reservationSets.delete(member.reservationSetId)
    }
    if (input.responsePending) {
      this.guards.set(key, {
        connectionEpoch: input.connectionEpoch,
        rpcId: input.rpcId,
        method: input.method,
        bindingId: input.bindingId,
        nativeId: input.nativeId,
      })
    }
  }

  releaseBeforeDispatch(input: {
    reservationSetId: string
    evidenceDigest: string
  }): void {
    requireIdentity(input.evidenceDigest, 'release_evidence_digest_invalid')
    const memberIds = this.reservationSets.get(input.reservationSetId)
    if (!memberIds) throw new CodexStartIdentityRegistryError('reservation_set_not_found')
    const members = memberIds.map((id) => this.members.get(id))
    if (members.some((member) => !member || member.state !== 'held')) {
      throw new CodexStartIdentityRegistryError('reservation_already_dispatched')
    }
    for (const memberId of memberIds) this.members.delete(memberId)
    this.reservationSets.delete(input.reservationSetId)
  }

  releaseAfterHostFailure(input: {
    reservationSetId: string
    productTerminalDigest: string
  }): void {
    requireIdentity(input.productTerminalDigest, 'host_failure_terminal_digest_invalid')
    const memberIds = this.reservationSets.get(input.reservationSetId)
    if (!memberIds) throw new CodexStartIdentityRegistryError('reservation_set_not_found')
    for (const memberId of memberIds) {
      const member = this.members.get(memberId)
      if (!member) throw new CodexStartIdentityRegistryError('reservation_member_not_found')
      if (member.connectionEpoch && member.rpcId) {
        this.activeRpcMembers.delete(rpcKey(member.connectionEpoch, member.rpcId))
      }
      this.members.delete(memberId)
    }
    this.reservationSets.delete(input.reservationSetId)
  }

  closeLateResponseGuard(input: LateResponseGuard & {
    reason: 'response_received' | 'connection_closed'
  }): void {
    const key = rpcKey(input.connectionEpoch, input.rpcId)
    const guard = this.guards.get(key)
    if (!guard) throw new CodexStartIdentityRegistryError('late_response_guard_not_found')
    if (
      guard.method !== input.method
      || guard.bindingId !== input.bindingId
      || guard.nativeId !== input.nativeId
    ) throw new CodexStartIdentityRegistryError('late_response_guard_identity_mismatch')
    this.guards.delete(key)
  }

  snapshot(): CodexStartIdentityRegistrySnapshot {
    return {
      capacity: this.options.capacity,
      capacityCharged: this.members.size,
      members: [...this.members.values()]
        .map(cloneMember)
        .sort((left, right) => left.reservationId.localeCompare(right.reservationId)),
      lateResponseGuards: [...this.guards.values()]
        .map((guard) => ({ ...guard }))
        .sort((left, right) => (
          left.connectionEpoch.localeCompare(right.connectionEpoch) || left.rpcId - right.rpcId
        )),
    }
  }
}

export function createCodexStartIdentityRegistryForRuntime(
  runtime: VerifiedCodexRuntime,
  snapshot?: CodexStartIdentityRegistryRestoreSnapshot,
): CodexStartIdentityRegistry {
  const registry = new CodexStartIdentityRegistry({
    capacity: runtime.manifest.startIdentityRegistryCapacity,
  })
  if (snapshot) registry.restore(snapshot)
  return registry
}
