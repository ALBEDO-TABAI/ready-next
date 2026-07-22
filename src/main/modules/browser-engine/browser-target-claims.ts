import { randomUUID } from 'node:crypto'

import type { AgentBrowserSurface, AgentBrowserStructuredError } from './agent-browser-errors'
import { agentBrowserError } from './agent-browser-errors'
import type {
  WorkflowDatabaseAccessor,
  WorkflowRawDatabase,
} from '../repositories/browser-workflow-unit-of-work'
import { BrowserWorkflowUnitOfWork } from '../repositories/browser-workflow-unit-of-work'

export type BrowserTargetClaimState = 'held' | 'user_owned' | 'suspended' | 'expired' | 'released'
export type BrowserTargetUserSignalSource = 'keyboard' | 'pointer' | 'navigation' | 'explicit-button'

export interface BrowserLogicalTargetKey {
  partition: string
  tabId: string
}

export interface BrowserPhysicalTargetKey extends BrowserLogicalTargetKey {
  physicalTargetToken: string
  bootIncarnationId: string
}

export interface BrowserTargetClaim {
  version: 1
  claimId: string
  generation: number
  logicalKey: BrowserLogicalTargetKey
  physicalTargetToken: string | null
  bootIncarnationId: string | null
  profileId: string | null
  surface: AgentBrowserSurface
  parentTaskId: string
  browserTaskId: string
  ownerRunId: string
  scopeId: string | null
  sessionId: string | null
  state: BrowserTargetClaimState
  suspensionCheckpointId: string | null
  suspensionReason: string | null
  acquiredAt: number
  heartbeatAt: number
  expiresAt: number
  updatedAt: number
}

export interface BrowserTargetClaimAcquireInput extends BrowserPhysicalTargetKey {
  profileId: string | null
  surface: AgentBrowserSurface
  parentTaskId: string
  browserTaskId: string
  ownerRunId: string
  scopeId: string | null
  sessionId: string | null
  ttlMs?: number
}

export interface BrowserTargetClaimIdentity extends BrowserPhysicalTargetKey {
  claimId: string
  generation: number
  ownerRunId: string
}

export type BrowserControlReceiptKind =
  | 'claim_acquired' | 'target_user_owned' | 'target_stale'
  | 'claim_resumed' | 'claim_suspended' | 'claim_released'
  | 'claim_expired' | 'target_closed_or_replaced'

export interface BrowserControlReceipt {
  receiptId: string
  sequence: number
  parentTaskId: string
  browserTaskId: string
  ownerRunId: string
  logicalTargetKey: BrowserLogicalTargetKey
  physicalTargetToken: string | null
  bootIncarnationId: string | null
  previousClaimId: string | null
  previousGeneration: number | null
  nextClaimId: string
  nextGeneration: number
  suspensionCheckpointId: string | null
  idempotencyKey: string
  kind: BrowserControlReceiptKind
  recoverable: boolean
  createdAt: string
}

interface BrowserTargetClaimRow {
  partition: string
  tab_id: string
  physical_target_token: string | null
  boot_incarnation_id: string | null
  claim_id: string
  generation: number
  profile_id: string | null
  surface: AgentBrowserSurface
  parent_task_id: string
  browser_task_id: string
  owner_run_id: string
  scope_id: string | null
  session_id: string | null
  state: BrowserTargetClaimState
  suspension_checkpoint_id: string | null
  suspension_reason: string | null
  acquired_at: number
  heartbeat_at: number
  expires_at: number
  updated_at: number
}

function mapClaim(row: BrowserTargetClaimRow): BrowserTargetClaim {
  return {
    version: 1,
    claimId: row.claim_id,
    generation: row.generation,
    logicalKey: { partition: row.partition, tabId: row.tab_id },
    physicalTargetToken: row.physical_target_token,
    bootIncarnationId: row.boot_incarnation_id,
    profileId: row.profile_id,
    surface: row.surface,
    parentTaskId: row.parent_task_id,
    browserTaskId: row.browser_task_id,
    ownerRunId: row.owner_run_id,
    scopeId: row.scope_id,
    sessionId: row.session_id,
    state: row.state,
    suspensionCheckpointId: row.suspension_checkpoint_id,
    suspensionReason: row.suspension_reason,
    acquiredAt: row.acquired_at,
    heartbeatAt: row.heartbeat_at,
    expiresAt: row.expires_at,
    updatedAt: row.updated_at,
  }
}

function samePhysicalIdentity(
  claim: BrowserTargetClaim,
  target: BrowserPhysicalTargetKey,
): boolean {
  return claim.logicalKey.partition === target.partition
    && claim.logicalKey.tabId === target.tabId
    && claim.physicalTargetToken === target.physicalTargetToken
    && claim.bootIncarnationId === target.bootIncarnationId
}

export interface BrowserTargetClaimStore {
  read(key: BrowserLogicalTargetKey): BrowserTargetClaim | null
  list(): BrowserTargetClaim[]
  mutate<T>(body: (store: BrowserTargetClaimMutationStore) => T): T
}

export interface BrowserTargetClaimMutationStore {
  read(key: BrowserLogicalTargetKey): BrowserTargetClaim | null
  write(claim: BrowserTargetClaim, expectedGeneration: number | null): boolean
  appendReceipt(receipt: Omit<BrowserControlReceipt, 'sequence'>): void
}

export class BrowserTargetClaimRepository implements BrowserTargetClaimStore {
  private readonly unitOfWork: BrowserWorkflowUnitOfWork

  constructor(private readonly accessor: WorkflowDatabaseAccessor) {
    this.unitOfWork = new BrowserWorkflowUnitOfWork(accessor)
  }

  private db(): WorkflowRawDatabase {
    const db = this.accessor.getRawDb()
    if (!db) throw new Error('Database not available')
    return db
  }

  private readFrom(db: WorkflowRawDatabase, key: BrowserLogicalTargetKey): BrowserTargetClaim | null {
    const row = db.prepare(
      'SELECT * FROM browser_target_claims WHERE partition = ? AND tab_id = ? LIMIT 1',
    ).get<BrowserTargetClaimRow>(key.partition, key.tabId)
    return row ? mapClaim(row) : null
  }

  read(key: BrowserLogicalTargetKey): BrowserTargetClaim | null {
    return this.readFrom(this.db(), key)
  }

  list(): BrowserTargetClaim[] {
    return this.db().prepare(
      'SELECT * FROM browser_target_claims ORDER BY updated_at DESC, partition, tab_id',
    ).all<BrowserTargetClaimRow>().map(mapClaim)
  }

  mutate<T>(body: (store: BrowserTargetClaimMutationStore) => T): T {
    return this.unitOfWork.runImmediate((db) => body({
      read: (key) => this.readFrom(db, key),
      write: (claim, expectedGeneration) => {
        const result = db.prepare(`
          INSERT INTO browser_target_claims (
            partition, tab_id, physical_target_token, boot_incarnation_id,
            claim_id, generation, profile_id, surface,
            parent_task_id, browser_task_id, owner_run_id, scope_id, session_id,
            state, suspension_checkpoint_id, suspension_reason,
            acquired_at, heartbeat_at, expires_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(partition, tab_id) DO UPDATE SET
            physical_target_token = excluded.physical_target_token,
            boot_incarnation_id = excluded.boot_incarnation_id,
            claim_id = excluded.claim_id,
            generation = excluded.generation,
            profile_id = excluded.profile_id,
            surface = excluded.surface,
            parent_task_id = excluded.parent_task_id,
            browser_task_id = excluded.browser_task_id,
            owner_run_id = excluded.owner_run_id,
            scope_id = excluded.scope_id,
            session_id = excluded.session_id,
            state = excluded.state,
            suspension_checkpoint_id = excluded.suspension_checkpoint_id,
            suspension_reason = excluded.suspension_reason,
            acquired_at = excluded.acquired_at,
            heartbeat_at = excluded.heartbeat_at,
            expires_at = excluded.expires_at,
            updated_at = excluded.updated_at
          WHERE browser_target_claims.generation = ?
        `).run(
          claim.logicalKey.partition,
          claim.logicalKey.tabId,
          claim.physicalTargetToken,
          claim.bootIncarnationId,
          claim.claimId,
          claim.generation,
          claim.profileId,
          claim.surface,
          claim.parentTaskId,
          claim.browserTaskId,
          claim.ownerRunId,
          claim.scopeId,
          claim.sessionId,
          claim.state,
          claim.suspensionCheckpointId,
          claim.suspensionReason,
          claim.acquiredAt,
          claim.heartbeatAt,
          claim.expiresAt,
          claim.updatedAt,
          expectedGeneration ?? claim.generation,
        ) as { changes?: number }
        return Number(result.changes || 0) === 1
      },
      appendReceipt: (receipt) => {
        const sequence = Number(db.prepare(
          'SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM browser_control_receipts WHERE browser_task_id = ?',
        ).get<{ sequence: number }>(receipt.browserTaskId)?.sequence || 1)
        db.prepare(`
          INSERT INTO browser_control_receipts (
            receipt_id, sequence, parent_task_id, browser_task_id, owner_run_id,
            partition, tab_id, physical_target_token, boot_incarnation_id,
            previous_claim_id, previous_generation, next_claim_id, next_generation,
            clean_base_checkpoint_id, suspension_checkpoint_id, wake_id, successor_run_id,
            continuation_generation, idempotency_key, kind, error_code, recoverable, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, ?, ?, NULL, ?, ?)
        `).run(
          receipt.receiptId, sequence, receipt.parentTaskId, receipt.browserTaskId, receipt.ownerRunId,
          receipt.logicalTargetKey.partition, receipt.logicalTargetKey.tabId,
          receipt.physicalTargetToken, receipt.bootIncarnationId,
          receipt.previousClaimId, receipt.previousGeneration, receipt.nextClaimId, receipt.nextGeneration,
          receipt.suspensionCheckpointId, receipt.idempotencyKey, receipt.kind,
          receipt.recoverable ? 1 : 0, receipt.createdAt,
        )
      },
    }))
  }
}

export class MemoryBrowserTargetClaimRepository implements BrowserTargetClaimStore {
  private readonly rows = new Map<string, BrowserTargetClaim>()
  private readonly receipts: BrowserControlReceipt[] = []

  private key(input: BrowserLogicalTargetKey): string {
    return `${input.partition}\u0000${input.tabId}`
  }

  read(key: BrowserLogicalTargetKey): BrowserTargetClaim | null {
    const row = this.rows.get(this.key(key))
    return row ? structuredClone(row) : null
  }

  list(): BrowserTargetClaim[] {
    return [...this.rows.values()].map((row) => structuredClone(row))
  }

  mutate<T>(body: (store: BrowserTargetClaimMutationStore) => T): T {
    return body({
      read: (key) => this.read(key),
      write: (claim, expectedGeneration) => {
        const key = this.key(claim.logicalKey)
        const current = this.rows.get(key)
        if (current && current.generation !== expectedGeneration) return false
        if (!current && expectedGeneration !== null) return false
        this.rows.set(key, structuredClone(claim))
        return true
      },
      appendReceipt: (receipt) => {
        this.receipts.push({ ...structuredClone(receipt), sequence: this.receipts.length + 1 })
      },
    })
  }

  listReceipts(): BrowserControlReceipt[] {
    return structuredClone(this.receipts)
  }
}

export interface BrowserTargetClaimTransition {
  logicalKey: BrowserLogicalTargetKey
  previousState: BrowserTargetClaimState | null
  state: BrowserTargetClaimState
  previousClaimId: string | null
  claimId: string
  generation: number
  source: 'acquire' | 'heartbeat' | 'release' | 'user_signal' | 'suspend' | 'resume' | 'expire' | 'close' | 'replace' | 'restart'
}

interface BrowserTargetClaimServiceOptions {
  now?: () => number
  defaultTtlMs?: number
  generateId?: () => string
}

export class BrowserTargetClaimService {
  private readonly now: () => number
  private readonly defaultTtlMs: number
  private readonly generateId: () => string
  private readonly transitionListeners = new Set<(transition: BrowserTargetClaimTransition) => void>()
  private readonly activeActions = new Map<string, Set<string>>()

  constructor(
    private readonly store: BrowserTargetClaimStore,
    options: BrowserTargetClaimServiceOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now())
    this.defaultTtlMs = options.defaultTtlMs ?? 60_000
    this.generateId = options.generateId ?? (() => `claim-${randomUUID()}`)
  }

  onTransition(listener: (transition: BrowserTargetClaimTransition) => void): () => void {
    this.transitionListeners.add(listener)
    return () => this.transitionListeners.delete(listener)
  }

  private emit(previous: BrowserTargetClaim | null, next: BrowserTargetClaim, source: BrowserTargetClaimTransition['source']): void {
    if (previous?.state === next.state && previous.claimId === next.claimId) return
    for (const listener of this.transitionListeners) {
      listener({
        logicalKey: next.logicalKey,
        previousState: previous?.state ?? null,
        state: next.state,
        previousClaimId: previous?.claimId ?? null,
        claimId: next.claimId,
        generation: next.generation,
        source,
      })
    }
  }

  private transition(
    previous: BrowserTargetClaim,
    patch: Partial<BrowserTargetClaim>,
    source: BrowserTargetClaimTransition['source'],
  ): BrowserTargetClaim {
    const at = this.now()
    const next: BrowserTargetClaim = {
      ...previous,
      ...patch,
      version: 1,
      claimId: this.generateId(),
      generation: previous.generation + 1,
      updatedAt: at,
    }
    const written = this.store.mutate((store) => {
      if (!store.write(next, previous.generation)) return false
      store.appendReceipt(this.receipt(previous, next, source))
      return true
    })
    if (!written) throw new Error('browser_target_claim_cas_conflict')
    this.activeActions.delete(previous.claimId)
    this.emit(previous, next, source)
    return next
  }

  private receipt(
    previous: BrowserTargetClaim | null,
    next: BrowserTargetClaim,
    source: BrowserTargetClaimTransition['source'],
  ): Omit<BrowserControlReceipt, 'sequence'> {
    const kind: BrowserControlReceiptKind = source === 'acquire' ? 'claim_acquired'
      : source === 'user_signal' ? 'target_user_owned'
      : source === 'suspend' ? 'claim_suspended'
      : source === 'resume' ? 'claim_resumed'
      : source === 'release' ? 'claim_released'
      : source === 'expire' || source === 'restart' ? 'claim_expired'
      : source === 'replace' ? 'target_stale'
      : 'target_closed_or_replaced'
    return {
      receiptId: `browser-control-${randomUUID()}`,
      parentTaskId: next.parentTaskId,
      browserTaskId: next.browserTaskId,
      ownerRunId: next.ownerRunId,
      logicalTargetKey: next.logicalKey,
      physicalTargetToken: next.physicalTargetToken,
      bootIncarnationId: next.bootIncarnationId,
      previousClaimId: previous?.claimId ?? null,
      previousGeneration: previous?.generation ?? null,
      nextClaimId: next.claimId,
      nextGeneration: next.generation,
      suspensionCheckpointId: next.suspensionCheckpointId,
      idempotencyKey: `${kind}:${next.claimId}:${next.generation}`,
      kind,
      recoverable: next.state === 'suspended' || next.state === 'user_owned',
      createdAt: new Date(next.updatedAt).toISOString(),
    }
  }

  acquire(input: BrowserTargetClaimAcquireInput): BrowserTargetClaim | AgentBrowserStructuredError {
    const at = this.now()
    const ttlMs = Math.max(1_000, input.ttlMs ?? this.defaultTtlMs)
    const result = this.store.mutate((store) => {
      const key = { partition: input.partition, tabId: input.tabId }
      const current = store.read(key)
      if (current?.state === 'held') {
        if (
          current.ownerRunId === input.ownerRunId
          && current.parentTaskId === input.parentTaskId
          && current.browserTaskId === input.browserTaskId
          && samePhysicalIdentity(current, input)
        ) {
          const renewed = { ...current, heartbeatAt: at, expiresAt: at + ttlMs, updatedAt: at }
          if (!store.write(renewed, current.generation)) throw new Error('browser_target_claim_cas_conflict')
          return renewed
        }
        return agentBrowserError('lease_held', `Target ${input.tabId} is already held by another Browser owner.`, {
          partition: input.partition,
          tabId: input.tabId,
          heldBy: current.ownerRunId,
          claimId: current.claimId,
          generation: current.generation,
        })
      }
      if (current?.state === 'user_owned') {
        return agentBrowserError('lease_takeover', `Target ${input.tabId} is under user control.`, {
          partition: input.partition,
          tabId: input.tabId,
          claimId: current.claimId,
          generation: current.generation,
        })
      }
      if (current?.state === 'suspended') {
        return agentBrowserError('lease_required', `Target ${input.tabId} requires an authorized continuation before it can be resumed.`, {
          partition: input.partition,
          tabId: input.tabId,
          state: current.state,
          suspensionCheckpointId: current.suspensionCheckpointId,
        })
      }
      const claim: BrowserTargetClaim = {
        version: 1,
        claimId: this.generateId(),
        generation: (current?.generation ?? 0) + 1,
        logicalKey: key,
        physicalTargetToken: input.physicalTargetToken,
        bootIncarnationId: input.bootIncarnationId,
        profileId: input.profileId,
        surface: input.surface,
        parentTaskId: input.parentTaskId,
        browserTaskId: input.browserTaskId,
        ownerRunId: input.ownerRunId,
        scopeId: input.scopeId,
        sessionId: input.sessionId,
        state: 'held',
        suspensionCheckpointId: null,
        suspensionReason: null,
        acquiredAt: at,
        heartbeatAt: at,
        expiresAt: at + ttlMs,
        updatedAt: at,
      }
      if (!store.write(claim, current?.generation ?? null)) throw new Error('browser_target_claim_cas_conflict')
      store.appendReceipt(this.receipt(current, claim, 'acquire'))
      return { previous: current, claim }
    })
    if ('previous' in result) {
      this.emit(result.previous, result.claim, 'acquire')
      return result.claim
    }
    return result
  }

  read(key: BrowserLogicalTargetKey): BrowserTargetClaim | null {
    const current = this.store.read(key)
    if (!current || current.state !== 'held' || this.now() <= current.expiresAt) return current
    return this.transition(current, {
      state: 'expired',
      physicalTargetToken: null,
      bootIncarnationId: null,
      suspensionCheckpointId: null,
      suspensionReason: null,
    }, 'expire')
  }

  list(): BrowserTargetClaim[] {
    return this.store.list().map((claim) => this.read(claim.logicalKey) ?? claim)
  }

  heldForRun(ownerRunId: string): BrowserTargetClaim[] {
    return this.list().filter((claim) => claim.ownerRunId === ownerRunId && claim.state === 'held')
  }

  heartbeat(identity: BrowserTargetClaimIdentity, ttlMs?: number): BrowserTargetClaim | AgentBrowserStructuredError {
    const current = this.read(identity)
    if (!current) return agentBrowserError('lease_required', `Target claim ${identity.claimId} was not found.`)
    if (
      current.state !== 'held'
      || current.claimId !== identity.claimId
      || current.generation !== identity.generation
      || current.ownerRunId !== identity.ownerRunId
      || !samePhysicalIdentity(current, identity)
    ) {
      return agentBrowserError(current.state === 'user_owned' ? 'lease_takeover' : 'lease_required', 'Browser target owner is stale.', {
        state: current.state,
        currentClaimId: current.claimId,
        currentGeneration: current.generation,
      })
    }
    const at = this.now()
    const renewed = {
      ...current,
      heartbeatAt: at,
      expiresAt: at + Math.max(1_000, ttlMs ?? this.defaultTtlMs),
      updatedAt: at,
    }
    const written = this.store.mutate((store) => store.write(renewed, current.generation))
    if (!written) return agentBrowserError('lease_required', 'Browser target owner changed during heartbeat.')
    return renewed
  }

  checkWrite(identity: BrowserTargetClaimIdentity): AgentBrowserStructuredError | null {
    const current = this.heartbeat(identity)
    return 'ok' in current && current.ok === false ? current : null
  }

  beginAgentAction(identity: BrowserTargetClaimIdentity): string | AgentBrowserStructuredError {
    const denied = this.checkWrite(identity)
    if (denied) return denied
    const correlationId = `browser-action-${randomUUID()}`
    const actions = this.activeActions.get(identity.claimId) ?? new Set<string>()
    actions.add(correlationId)
    this.activeActions.set(identity.claimId, actions)
    return correlationId
  }

  endAgentAction(identity: BrowserTargetClaimIdentity, correlationId: string): void {
    const actions = this.activeActions.get(identity.claimId)
    actions?.delete(correlationId)
    if (actions?.size === 0) this.activeActions.delete(identity.claimId)
  }

  hasActiveAgentAction(identity: BrowserTargetClaimIdentity): boolean {
    return (this.activeActions.get(identity.claimId)?.size ?? 0) > 0
  }

  recordUserSignal(input: {
    target: BrowserPhysicalTargetKey
    source: BrowserTargetUserSignalSource
    suspensionCheckpointId: string
    suspensionReason?: string
  }): BrowserTargetClaim | null {
    const current = this.read(input.target)
    if (!current || current.state !== 'held' || !samePhysicalIdentity(current, input.target)) return null
    if (input.source === 'navigation' && this.activeActions.get(current.claimId)?.size) return null
    return this.transition(current, {
      state: 'user_owned',
      suspensionCheckpointId: input.suspensionCheckpointId,
      suspensionReason: input.suspensionReason ?? 'browser_target_user_owned',
      expiresAt: this.now(),
    }, 'user_signal')
  }

  release(identity: BrowserTargetClaimIdentity): BrowserTargetClaim | null {
    const current = this.read(identity)
    if (!current || current.state !== 'held') return current
    if (
      current.claimId !== identity.claimId
      || current.generation !== identity.generation
      || current.ownerRunId !== identity.ownerRunId
      || !samePhysicalIdentity(current, identity)
    ) return current
    return this.transition(current, {
      state: 'released',
      physicalTargetToken: null,
      bootIncarnationId: null,
      suspensionCheckpointId: null,
      suspensionReason: null,
      expiresAt: this.now(),
    }, 'release')
  }

  closeTarget(key: BrowserLogicalTargetKey): BrowserTargetClaim | null {
    const current = this.read(key)
    if (!current) return null
    const state = current.state === 'user_owned' ? 'released' : 'expired'
    return this.transition(current, {
      state,
      physicalTargetToken: null,
      bootIncarnationId: null,
      suspensionCheckpointId: null,
      suspensionReason: null,
      expiresAt: this.now(),
    }, 'close')
  }

  replacePhysicalTarget(
    target: BrowserPhysicalTargetKey,
    suspensionCheckpointId?: string | null,
  ): BrowserTargetClaim | null {
    const current = this.read(target)
    if (!current || samePhysicalIdentity(current, target)) return current
    if (current.state === 'held') {
      if (!suspensionCheckpointId) throw new Error('target_stale_checkpoint_required')
      return this.transition(current, {
        state: 'suspended',
        physicalTargetToken: target.physicalTargetToken,
        bootIncarnationId: target.bootIncarnationId,
        suspensionCheckpointId,
        suspensionReason: 'browser_target_replaced',
        expiresAt: this.now(),
      }, 'replace')
    }
    if (current.state === 'suspended') {
      return this.transition(current, {
        physicalTargetToken: target.physicalTargetToken,
        bootIncarnationId: target.bootIncarnationId,
      }, 'replace')
    }
    if (current.state === 'user_owned') {
      return this.transition(current, {
        physicalTargetToken: null,
        bootIncarnationId: null,
      }, 'replace')
    }
    return current
  }

  closeoutRun(input: {
    ownerRunId: string
    resumable: boolean
    suspensionCheckpointId?: string | null
    suspensionReason?: string | null
  }): BrowserTargetClaim[] {
    const settled: BrowserTargetClaim[] = []
    const canSuspend = Boolean(input.resumable && input.suspensionCheckpointId)
    for (const claim of this.heldForRun(input.ownerRunId)) {
      settled.push(this.transition(claim, canSuspend ? {
        state: 'suspended',
        physicalTargetToken: null,
        bootIncarnationId: null,
        suspensionCheckpointId: input.suspensionCheckpointId!,
        suspensionReason: input.suspensionReason || 'browser_run_checkpoint',
        expiresAt: this.now(),
      } : {
        state: 'released',
        physicalTargetToken: null,
        bootIncarnationId: null,
        suspensionCheckpointId: null,
        suspensionReason: null,
        expiresAt: this.now(),
      }, canSuspend ? 'suspend' : 'release'))
    }
    return settled
  }

  expireBoot(bootIncarnationId: string): BrowserTargetClaim[] {
    const settled: BrowserTargetClaim[] = []
    for (const claim of this.list()) {
      if (claim.bootIncarnationId !== bootIncarnationId) continue
      if (claim.state === 'held') {
        settled.push(this.transition(claim, {
          state: 'expired',
          physicalTargetToken: null,
          bootIncarnationId: null,
          suspensionCheckpointId: null,
          suspensionReason: null,
          expiresAt: this.now(),
        }, 'restart'))
      } else if (claim.state === 'suspended' || claim.state === 'user_owned') {
        settled.push(this.transition(claim, {
          physicalTargetToken: null,
          bootIncarnationId: null,
        }, 'restart'))
      }
    }
    return settled
  }
}

export function bootIncarnationIdFromPhysicalTargetToken(token: string): string {
  const separator = token.indexOf(':')
  return separator > 0 ? token.slice(0, separator) : token
}

export function partitionForBrowserProfile(profileId: string | null | undefined): string {
  const profile = String(profileId || '').trim().toLowerCase()
  return profile ? `persist:browser-profile-${profile}` : 'persist:browser'
}
