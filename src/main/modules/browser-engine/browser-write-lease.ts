/**
 * BrowserWriteLease — Agent Browser write-lock (counterplan §5.2, WP1).
 *
 * One lease per surface (`user-view` / `agent-view`). Only write calls require
 * a lease; reads are free. The lease is NOT a task state machine: states are
 * `idle / held / takeover / expired` only (the review removed `paused` — that
 * lives on the task runner — and merged `released` back into `idle`).
 *
 * Takeover identification (the part that makes "user takeover is instant" real
 * rather than a slogan): every agent write is wrapped in an action window
 * (beginAgentAction → endAgentAction). User-origin signals (keyboard, an
 * unmatched navigation, an explicit takeover button) that arrive OUTSIDE any
 * open action window — and after a short post-action grace period — flip the
 * surface to `takeover`, after which every agent write is rejected with
 * `lease_takeover`.
 *
 * Time is injected so expiry/grace are deterministic under test.
 *
 * Pure module — no Electron, no IO.
 */

import {
  agentBrowserError,
  type AgentBrowserStructuredError,
  type AgentBrowserSurface,
} from './agent-browser-errors'

export type BrowserLeaseState = 'idle' | 'held' | 'takeover' | 'expired'

export type UserSignalSource = 'keyboard' | 'navigation' | 'tab-switch' | 'explicit-button'

export interface BrowserWriteLease {
  leaseId: string
  surface: AgentBrowserSurface
  taskId: string
  runId: string
  tabId: string | null
  acquiredAt: number
  expiresAt: number
  lastHeartbeatAt: number
}

interface SurfaceState {
  state: BrowserLeaseState
  lease: BrowserWriteLease | null
  openActions: Set<string>
  /** Agent-origin grace window: user signals before this time are suppressed. */
  suppressUntil: number
}

export interface BrowserWriteLeaseOptions {
  now?: () => number
  defaultTtlMs?: number
  /** Grace after an agent action closes during which signals stay agent-attributed. */
  actionGraceMs?: number
  /** Monotonic id source for leases / correlationIds (injectable for tests). */
  generateId?: (prefix: string) => string
}

export interface BrowserLeaseTransition {
  surface: AgentBrowserSurface
  previousState: BrowserLeaseState
  state: BrowserLeaseState
  leaseId: string | null
  source: 'acquire' | 'release' | 'user_signal' | 'clear' | 'expire'
}

const SURFACES: AgentBrowserSurface[] = ['user-view', 'agent-view']

export class BrowserWriteLeaseService {
  private readonly now: () => number
  private readonly defaultTtlMs: number
  private readonly actionGraceMs: number
  private readonly generateId: (prefix: string) => string
  private seq = 0
  private surfaces: Record<AgentBrowserSurface, SurfaceState>
  private transitionListeners = new Set<(transition: BrowserLeaseTransition) => void>()

  constructor(options: BrowserWriteLeaseOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    this.defaultTtlMs = options.defaultTtlMs ?? 60_000
    this.actionGraceMs = options.actionGraceMs ?? 1_500
    this.generateId =
      options.generateId ?? ((prefix: string) => `${prefix}-${(this.seq += 1)}`)
    this.surfaces = {
      'user-view': this.freshSurface(),
      'agent-view': this.freshSurface(),
    }
  }

  private freshSurface(): SurfaceState {
    return { state: 'idle', lease: null, openActions: new Set(), suppressUntil: 0 }
  }

  onTransition(listener: (transition: BrowserLeaseTransition) => void): () => void {
    this.transitionListeners.add(listener)
    return () => {
      this.transitionListeners.delete(listener)
    }
  }

  private emitTransition(
    surface: AgentBrowserSurface,
    previousState: BrowserLeaseState,
    source: BrowserLeaseTransition['source'],
  ): void {
    const s = this.surfaces[surface]
    if (previousState === s.state) return
    const transition: BrowserLeaseTransition = {
      surface,
      previousState,
      state: s.state,
      leaseId: s.lease?.leaseId ?? null,
      source,
    }
    for (const listener of this.transitionListeners) {
      listener(transition)
    }
  }

  /** Lazily roll a held-but-expired lease to `expired` before any read of state. */
  private reconcile(surface: AgentBrowserSurface): SurfaceState {
    const s = this.surfaces[surface]
    if (s.state === 'held' && s.lease && this.now() > s.lease.expiresAt) {
      const previous = s.state
      s.state = 'expired'
      this.emitTransition(surface, previous, 'expire')
    }
    return s
  }

  getState(surface: AgentBrowserSurface): BrowserLeaseState {
    return this.reconcile(surface).state
  }

  getLease(surface: AgentBrowserSurface): BrowserWriteLease | null {
    const s = this.reconcile(surface)
    return s.state === 'held' ? s.lease : null
  }

  acquire(params: {
    surface: AgentBrowserSurface
    taskId: string
    runId: string
    tabId?: string | null
    ttlMs?: number
  }): BrowserWriteLease | AgentBrowserStructuredError {
    const s = this.reconcile(params.surface)
    if (s.state === 'held' && s.lease) {
      return agentBrowserError(
        'lease_held',
        `Surface ${params.surface} is already locked by task ${s.lease.taskId}.`,
        { surface: params.surface, heldBy: s.lease.taskId, leaseId: s.lease.leaseId },
      )
    }
    if (s.state === 'takeover') {
      // The user is actively driving this surface; no task may seize it until the
      // takeover is explicitly cleared (clearTakeover). Do NOT overwrite it.
      return agentBrowserError(
        'lease_takeover',
        `Surface ${params.surface} is under user takeover; acquire is blocked until it is cleared.`,
        { surface: params.surface },
      )
    }
    const at = this.now()
    const ttl = Math.max(1_000, params.ttlMs ?? this.defaultTtlMs)
    const previous = s.state
    const lease: BrowserWriteLease = {
      leaseId: this.generateId('lease'),
      surface: params.surface,
      taskId: params.taskId,
      runId: params.runId,
      tabId: params.tabId ?? null,
      acquiredAt: at,
      expiresAt: at + ttl,
      lastHeartbeatAt: at,
    }
    s.state = 'held'
    s.lease = lease
    s.openActions.clear()
    s.suppressUntil = 0
    this.emitTransition(params.surface, previous, 'acquire')
    return lease
  }

  heartbeat(leaseId: string, ttlMs?: number): BrowserWriteLease | AgentBrowserStructuredError {
    for (const surface of SURFACES) {
      const s = this.reconcile(surface)
      if (s.lease?.leaseId === leaseId) {
        if (s.state !== 'held') {
          return agentBrowserError(
            s.state === 'takeover' ? 'lease_takeover' : 'lease_required',
            `Lease ${leaseId} is no longer active (${s.state}).`,
            { surface, state: s.state },
          )
        }
        const at = this.now()
        s.lease.lastHeartbeatAt = at
        s.lease.expiresAt = at + Math.max(1_000, ttlMs ?? this.defaultTtlMs)
        return s.lease
      }
    }
    return agentBrowserError('lease_required', `Lease ${leaseId} not found.`)
  }

  release(leaseId: string): void {
    for (const surface of SURFACES) {
      const s = this.surfaces[surface]
      if (s.lease?.leaseId === leaseId) {
        if (s.state === 'takeover') {
          // The user has taken over; the lease is already revoked. Releasing it
          // must NOT reset the surface to idle, or a new task could seize it
          // without the required clearTakeover. Drop only the lease reference
          // and keep the surface in takeover until it is explicitly cleared.
          s.lease = null
          s.openActions.clear()
          return
        }
        const previous = s.state
        this.surfaces[surface] = this.freshSurface()
        this.emitTransition(surface, previous, 'release')
        return
      }
    }
  }

  /**
   * Gate a write call. Returns null when the write is permitted, or a structured
   * error (lease_required / lease_takeover) otherwise.
   */
  checkWrite(params: {
    surface: AgentBrowserSurface
    leaseId: string | null | undefined
  }): AgentBrowserStructuredError | null {
    const s = this.reconcile(params.surface)
    if (s.state === 'takeover') {
      return agentBrowserError(
        'lease_takeover',
        `User has taken over ${params.surface}; agent writes are suspended.`,
        { surface: params.surface },
      )
    }
    if (s.state !== 'held' || !s.lease) {
      return agentBrowserError(
        'lease_required',
        `A write lease for ${params.surface} is required before this action.`,
        { surface: params.surface, state: s.state },
      )
    }
    if (!params.leaseId || params.leaseId !== s.lease.leaseId) {
      return agentBrowserError(
        'lease_required',
        `This write does not hold the active ${params.surface} lease.`,
        { surface: params.surface, expectedLeaseId: s.lease.leaseId },
      )
    }
    return null
  }

  /** Open an agent action window; signals during it are attributed to the agent. */
  beginAgentAction(surface: AgentBrowserSurface): string {
    const s = this.surfaces[surface]
    const correlationId = this.generateId('act')
    s.openActions.add(correlationId)
    return correlationId
  }

  endAgentAction(surface: AgentBrowserSurface, correlationId: string): void {
    const s = this.surfaces[surface]
    if (s.openActions.delete(correlationId)) {
      s.suppressUntil = this.now() + this.actionGraceMs
    }
  }

  /**
   * Record a user-origin signal. If a lease is held and the signal is not within
   * an agent action window (and the post-action grace has elapsed), the surface
   * flips to `takeover`. Returns true if a takeover was triggered.
   */
  recordUserSignal(params: { surface: AgentBrowserSurface; source: UserSignalSource }): boolean {
    const s = this.reconcile(params.surface)
    if (s.state !== 'held') return false

    // Signal strength layers (counterplan §5.2 接管识别):
    //  - explicit-button: deliberate, unambiguous — always wins, even mid-action.
    //  - keyboard: a user keypress is unambiguously user-origin (the agent types
    //    inside its own action window, which still suppresses it); it is NOT
    //    subject to the post-action grace, which only exists to swallow the
    //    navigation/scroll echo an agent action itself produces.
    //  - navigation / tab-switch: can be an echo of the agent's own action, so
    //    they are suppressed both during an open window and the post-action grace.
    if (params.source === 'explicit-button') {
      const previous = s.state
      s.state = 'takeover'
      this.emitTransition(params.surface, previous, 'user_signal')
      return true
    }
    if (s.openActions.size > 0) return false
    if (params.source !== 'keyboard' && this.now() < s.suppressUntil) return false

    const previous = s.state
    s.state = 'takeover'
    this.emitTransition(params.surface, previous, 'user_signal')
    return true
  }

  /** After the user is done, allow a fresh lease to be acquired again. */
  clearTakeover(surface: AgentBrowserSurface): void {
    const s = this.surfaces[surface]
    if (s.state === 'takeover' || s.state === 'expired') {
      const previous = s.state
      this.surfaces[surface] = this.freshSurface()
      this.emitTransition(surface, previous, 'clear')
    }
  }
}
