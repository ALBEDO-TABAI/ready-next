/**
 * Turn-level browser write lease owner for the free-tool-loop (plan §4.2, WP2).
 *
 * When browser tools are exposed to the model's free-tool-loop (by collection
 * intent or a browser workflow), the model can call browser write tools
 * directly. Those calls must be lease-protected so the agent cannot clobber the
 * page the user is reading, and so a user takeover instantly suspends them.
 *
 * Lifecycle:
 *   - ensureGate(): lazily acquires the default user-view lease.
 *   - ensureGateForSurface(): uses the same turn identity when a grounded target
 *     is code-resolved onto agent-view.
 *   - releaseForBackgroundHandoff(): when the model launches a background
 *     visible_collect, the turn releases its lease so the background task can
 *     own the surface (single-writer invariant); the turn's subsequent writes
 *     then get lease_held until the background task finishes.
 *   - release(): run cleanup (normal end / cancel / session close) releases.
 *
 * A new turn is not authority to clear a durable takeover/foreground fence.
 * Only the control-plane typed wake may bind a fresh owner before acquisition.
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
  private ended = false
  private readonly leaseIds: Record<AgentBrowserSurface, string | null> = {
    'user-view': null,
    'agent-view': null,
  }
  private readonly tabIds: Record<AgentBrowserSurface, string | null> = {
    'user-view': null,
    'agent-view': null,
  }

  constructor(
    private readonly ids: { taskId: string; runId: string },
    private readonly surface: AgentBrowserSurface = 'user-view',
    private readonly service: BrowserWriteLeaseService = getBrowserWriteLeaseService(),
  ) {}

  ensureGate(): BrowserLeaseGate | AgentBrowserStructuredError {
    return this.ensureGateForSurface(this.surface)
  }

  /**
   * Grounded main-Agent work can move from the user's tab to a claimed agent
   * tab without creating a second dispatcher. Keep both logical surfaces on
   * the same turn owner and lazily acquire only the one that the physical
   * target requires.
   */
  ensureGateForSurface(
    surface: AgentBrowserSurface,
    tabId: string | null = null,
  ): BrowserLeaseGate | AgentBrowserStructuredError {
    if (this.ended) {
      return agentBrowserError('lease_required', 'The turn has ended; no browser write lease is available.')
    }
    let leaseId = this.leaseIds[surface]
    if (!leaseId) {
      const lease = this.service.acquire({
        surface,
        taskId: this.ids.taskId,
        runId: this.ids.runId,
        tabId,
      })
      if (isAgentBrowserError(lease)) return lease
      leaseId = lease.leaseId
      this.leaseIds[surface] = leaseId
      this.tabIds[surface] = lease.tabId
    }
    const renewed = this.service.heartbeat(leaseId)
    if (isAgentBrowserError(renewed)) {
      if (renewed.errorCode !== 'lease_required' || renewed.detail?.state !== 'expired') return renewed
      const replacement = this.service.acquire({
        surface,
        taskId: this.ids.taskId,
        runId: this.ids.runId,
        tabId: this.tabIds[surface],
      })
      if (isAgentBrowserError(replacement)) return replacement
      leaseId = replacement.leaseId
      this.leaseIds[surface] = leaseId
      this.tabIds[surface] = replacement.tabId
    }
    return { service: this.service, surface, leaseId }
  }

  /** Whether a turn lease is currently held (used to decide handoff release). */
  get isHeld(): boolean {
    return this.leaseIds[this.surface] !== null
  }

  releaseForBackgroundHandoff(): void {
    for (const surface of ['user-view', 'agent-view'] as const) {
      const leaseId = this.leaseIds[surface]
      if (!leaseId) continue
      this.service.release(leaseId)
      this.leaseIds[surface] = null
      this.tabIds[surface] = null
    }
  }

  release(): void {
    for (const surface of ['user-view', 'agent-view'] as const) {
      const leaseId = this.leaseIds[surface]
      if (!leaseId) continue
      this.service.release(leaseId)
      this.leaseIds[surface] = null
      this.tabIds[surface] = null
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
