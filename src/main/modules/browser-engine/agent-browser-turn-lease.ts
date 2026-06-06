/**
 * Turn-level user-view write lease for the free-tool-loop (plan §4.2, WP2).
 *
 * When browser tools are exposed to the model's free-tool-loop (by collection
 * intent or a browser workflow), the model can call browser write tools
 * directly. Those calls must be lease-protected so the agent cannot clobber the
 * page the user is reading, and so a user takeover instantly suspends them.
 *
 * Lifecycle:
 *   - ensureGate(): lazily acquires ONE user-view lease for the turn and returns
 *     a gate; returns a structured error when the surface is busy (another task)
 *     or under user takeover.
 *   - releaseForBackgroundHandoff(): when the model launches a background
 *     visible_collect, the turn releases its lease so the background task can
 *     own the surface (single-writer invariant); the turn's subsequent writes
 *     then get lease_held until the background task finishes.
 *   - release(): run cleanup (normal end / cancel / session close) releases.
 *
 * Reaching ensureGate implies the user's CURRENT message exposed browser tools
 * (WP1 per-message intent gating) — i.e. the user just authorized browser work
 * — so a prior `takeover`/`expired` is cleared here (re-authorization, §4.7).
 */

import { getBrowserWriteLeaseService } from './agent-browser-lease-singleton'
import {
  isAgentBrowserError,
  agentBrowserError,
  type AgentBrowserStructuredError,
  type AgentBrowserSurface,
} from './agent-browser-errors'
import type { BrowserWriteLeaseService } from './browser-write-lease'
import type { BrowserLeaseGate } from './agent-browser-lease-gate'

export class BrowserTurnLease {
  private leaseId: string | null = null
  private ended = false
  private hasAcquiredOnce = false

  constructor(
    private readonly ids: { taskId: string; runId: string },
    private readonly surface: AgentBrowserSurface = 'user-view',
    private readonly service: BrowserWriteLeaseService = getBrowserWriteLeaseService(),
  ) {}

  ensureGate(): BrowserLeaseGate | AgentBrowserStructuredError {
    if (this.ended) {
      return agentBrowserError('lease_required', 'The turn has ended; no browser write lease is available.')
    }
    if (!this.leaseId) {
      // Re-authorization clears a prior takeover/expired ONLY on the turn's very
      // first acquire (the user's new browser-exposed message re-authorizes).
      // After the turn has acquired once — e.g. a visible_collect handoff
      // released the lease and the user then took over — a re-acquire must NOT
      // clear takeover, or the agent would steal back a page the user is now
      // driving. A surface actively `held` by a background task is also left
      // alone (acquire below returns lease_held).
      if (!this.hasAcquiredOnce) {
        const state = this.service.getState(this.surface)
        if (state === 'takeover' || state === 'expired') {
          this.service.clearTakeover(this.surface)
        }
      }
      const lease = this.service.acquire({
        surface: this.surface,
        taskId: this.ids.taskId,
        runId: this.ids.runId,
      })
      if (isAgentBrowserError(lease)) return lease
      this.leaseId = lease.leaseId
      this.hasAcquiredOnce = true
    }
    const renewed = this.service.heartbeat(this.leaseId)
    if (isAgentBrowserError(renewed)) return renewed
    return { service: this.service, surface: this.surface, leaseId: this.leaseId }
  }

  /** Whether a turn lease is currently held (used to decide handoff release). */
  get isHeld(): boolean {
    return this.leaseId !== null
  }

  releaseForBackgroundHandoff(): void {
    // Handing the surface to a background task counts as the turn engaging it,
    // even when visible_collect is the turn's FIRST action and no acquire ran.
    // After this, a later same-turn write must NOT clear a takeover (the user
    // may have taken over the background task) — so seal re-authorization here.
    this.hasAcquiredOnce = true
    if (this.leaseId) {
      this.service.release(this.leaseId)
      this.leaseId = null
    }
  }

  release(): void {
    if (this.leaseId) {
      this.service.release(this.leaseId)
      this.leaseId = null
    }
    this.ended = true
  }
}

export function createBrowserTurnLease(
  ids: { taskId: string; runId: string },
  service?: BrowserWriteLeaseService,
): BrowserTurnLease {
  return new BrowserTurnLease(ids, 'user-view', service ?? getBrowserWriteLeaseService())
}
