/**
 * Structured error codes for the Agent Browser / Visible Crawler line.
 *
 * These codes are part of the machine-verifiable contract (counterplan §5.2,
 * WP0.9). They are mutually exclusive, mirroring the existing
 * `tool_not_registered` vs `authorization_denied` precedent: each code means
 * exactly one thing and callers can branch on it deterministically.
 *
 * Pure module — no Electron, no IO.
 */

export type AgentBrowserSurface = 'user-view' | 'agent-view'

export type AgentBrowserErrorCode =
  /** A write call was attempted without holding a valid lease for the surface. */
  | 'lease_required'
  /** A second writer tried to acquire a lease already held by another task. */
  | 'lease_held'
  /** The lease was revoked because the user took over the surface. */
  | 'lease_takeover'
  /** A target_id was built against a stale page-map generation. */
  | 'stale_page_map'
  /** A target resolved to more than one element; refuse to blind-click. */
  | 'ambiguous_target'
  /** A target_id no longer resolves to any element on the current page. */
  | 'target_not_found'
  /** A login wall blocked an agent-view (lane B) collection. */
  | 'login_required'
  /** A high-control platform refused a script-hard tool / script param (§4.4). */
  | 'script_blocked'

export interface AgentBrowserStructuredError {
  ok: false
  errorCode: AgentBrowserErrorCode
  message: string
  /** Optional machine-readable detail (candidate list, current generation…). */
  detail?: Record<string, unknown>
}

export function agentBrowserError(
  errorCode: AgentBrowserErrorCode,
  message: string,
  detail?: Record<string, unknown>,
): AgentBrowserStructuredError {
  return detail === undefined
    ? { ok: false, errorCode, message }
    : { ok: false, errorCode, message, detail }
}

export function isAgentBrowserError(value: unknown): value is AgentBrowserStructuredError {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { ok?: unknown }).ok === false &&
    typeof (value as { errorCode?: unknown }).errorCode === 'string'
  )
}
