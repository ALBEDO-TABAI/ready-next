/**
 * Lane-A lease lifecycle (counterplan §5.1/§5.2, WP1 acceptance).
 *
 * Lane A is the user-authorized visible协驾: the agent operates on the user's
 * BrowserView. This wraps an agent run so that, for its whole duration, it holds
 * the `user-view` write lease and every write tool is gated by it. Extracted
 * from the (large, Electron-bound) browser agent runner so the lease lifecycle
 * is small and unit-testable; the runner just calls runUnderUserViewLease and
 * passes the supplied gate to executeBrowserTool.
 *
 * Acquire outcomes:
 *   - granted  → run fn(gate) holding the lease; release in finally.
 *   - lease_held / lease_takeover → do NOT seize the surface; return a typed
 *     `blocked` result so the caller can tell the user the surface is busy or
 *     under their own control, instead of silently double-driving the page.
 *
 * Pure-ish module — only depends on the lease service.
 */

import { isAgentBrowserError, type AgentBrowserStructuredError } from './agent-browser-errors'
import type { AgentBrowserSurface } from './agent-browser-errors'
import type { BrowserWriteLeaseService } from './browser-write-lease'
import type { BrowserLeaseGate } from './agent-browser-lease-gate'

export type LaneRunOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; blocked: AgentBrowserStructuredError }

export async function runUnderUserViewLease<T>(
  service: BrowserWriteLeaseService,
  params: { taskId: string; runId: string; tabId?: string | null; ttlMs?: number },
  fn: (gate: BrowserLeaseGate, heartbeat: () => void) => Promise<T>,
): Promise<LaneRunOutcome<T>> {
  return runUnderBrowserViewLease(service, { ...params, surface: 'user-view' }, fn)
}

export async function runUnderBrowserViewLease<T>(
  service: BrowserWriteLeaseService,
  params: {
    surface: AgentBrowserSurface
    taskId: string
    runId: string
    tabId?: string | null
    ttlMs?: number
  },
  fn: (gate: BrowserLeaseGate, heartbeat: () => void) => Promise<T>,
): Promise<LaneRunOutcome<T>> {
  const lease = service.acquire({
    surface: params.surface,
    taskId: params.taskId,
    runId: params.runId,
    tabId: params.tabId ?? null,
    ttlMs: params.ttlMs,
  })
  if (isAgentBrowserError(lease)) {
    return { ok: false, blocked: lease }
  }

  const gate: BrowserLeaseGate = { service, surface: params.surface, leaseId: lease.leaseId }
  const heartbeat = () => {
    service.heartbeat(lease.leaseId, params.ttlMs)
  }
  try {
    const value = await fn(gate, heartbeat)
    return { ok: true, value }
  } finally {
    service.release(lease.leaseId)
  }
}
