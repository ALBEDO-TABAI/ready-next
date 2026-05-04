/**
 * Stage 3 W4 — throttle wrapper for the `scope_create_persistence_failed`
 * renderer-agent metric.
 *
 * `useAgent.ts` calls `window.electronAPI.agent.createLocalScope(...)` from
 * five different sites (newSession + 4 sendMessage bootstrap blocks). All
 * of them currently swallow IPC failure into `.catch(() => null)` /
 * `.catch(console.error)`, so a recurring main-process issue is invisible
 * on the operator dashboard. The retry chain at useAgent.ts:1125-1148
 * already handles the common "scope not found" race; this metric is a
 * pure side-channel observation, no UI impact.
 *
 * Pure module: no React, no zustand, no IPC import — testable under plain
 * Node with a manual clock and a captured emit fn. Same shape as
 * `direct-chat-attachment-metrics.ts:AttachmentLoadFailureThrottle`.
 */

export type ScopeCreatePersistenceSite =
  | 'newSession'
  | 'sendMessage_no_scope'
  | 'sendMessage_local_scope_missing'
  | 'sendMessage_agent_mismatch'
  | 'sendMessage_ensure'

export type ScopeCreatePersistenceReason =
  | 'ipc_rejected'
  | 'ipc_unavailable'
  | 'result_failure'

export interface ScopeCreatePersistencePayload {
  site: ScopeCreatePersistenceSite
  reason: ScopeCreatePersistenceReason
  scopeId: string | null
  agent: string
}

export class ScopeCreatePersistenceMetricThrottle {
  private last = new Map<string, number>()
  private readonly cooldownMs: number
  private readonly clock: () => number
  private readonly emit: (payload: ScopeCreatePersistencePayload) => void

  constructor(
    cooldownMs: number,
    clock: () => number,
    emit: (payload: ScopeCreatePersistencePayload) => void,
  ) {
    this.cooldownMs = cooldownMs
    this.clock = clock
    this.emit = emit
  }

  /**
   * Returns `true` if a metric was emitted, `false` if suppressed by the
   * 5-minute cooldown.
   *
   * Throttle key: `agent | scopeId-or-<no-scope> | site | reason`.
   * Empty / null scopeId collapses into a single bucket per agent + site,
   * bounded to keep the throttle map's memory footprint deterministic
   * even under chronic IPC failure.
   */
  maybeEmit(
    site: ScopeCreatePersistenceSite,
    reason: ScopeCreatePersistenceReason,
    scopeId: string | null,
    agent: string,
  ): boolean {
    const key = `${agent}|${scopeId || '<no-scope>'}|${site}|${reason}`
    const now = this.clock()
    const last = this.last.get(key) ?? 0
    if (now - last < this.cooldownMs) return false
    this.last.set(key, now)
    this.emit({ site, reason, scopeId, agent })
    return true
  }
}
