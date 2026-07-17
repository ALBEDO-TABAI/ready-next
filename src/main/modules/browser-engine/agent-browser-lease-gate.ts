/**
 * Lease gate that fronts every browser tool call when running under an Agent
 * Browser lane (counterplan §5.2, WP1). It is OPT-IN: only callers that pass a
 * gate (the new lane-A/lane-B agent flows) are enforced. Legacy free-form
 * browser tool usage passes no gate and is unaffected — the lease scopes to the
 * new协驾 flow, it does not retroactively break existing call sites.
 *
 * On a write call it consults the lease (lease_required / lease_takeover) and,
 * when permitted, opens an agent action window so the simultaneous user-origin
 * navigation/key events the write itself produces are not misread as a takeover
 * (see browser-write-lease recordUserSignal).
 *
 * Pure-ish module — only depends on the lease service + classification.
 */

import { classifyBrowserToolCall } from './browser-tool-write-classification'
import { isAgentBrowserError } from './agent-browser-errors'
import type { AgentBrowserSurface } from './agent-browser-errors'
import type { BrowserWriteLeaseService } from './browser-write-lease'

export interface BrowserLeaseGate {
  service: BrowserWriteLeaseService
  surface: AgentBrowserSurface
  leaseId: string | null
}

export interface LeaseGateHandle {
  /** Non-null when the call is denied; the caller should return it verbatim. */
  deniedMessage: string | null
  /** Recheck and open the short agent-action window at the physical dispatch
   * boundary, after any origin queue/cooldown wait. */
  begin: () => string | null
  /** Always call once the tool finishes (closes the agent action window). */
  end: () => void
}

const NOOP = () => {}

export function beginLeaseGate(
  gate: BrowserLeaseGate | undefined,
  toolName: string,
  args: Record<string, unknown>,
): LeaseGateHandle {
  if (!gate) return { deniedMessage: null, begin: () => null, end: NOOP }

  const effect = classifyBrowserToolCall(toolName, args)
  if (effect === 'read') return { deniedMessage: null, begin: () => null, end: NOOP }

  const denied = gate.service.checkWrite({ surface: gate.surface, leaseId: gate.leaseId })
  if (denied && isAgentBrowserError(denied)) {
    return { deniedMessage: JSON.stringify(denied), begin: () => JSON.stringify(denied), end: NOOP }
  }

  let correlationId: string | null = null
  return {
    deniedMessage: null,
    begin: () => {
      if (correlationId) return null
      const boundaryDenied = gate.service.checkWrite({ surface: gate.surface, leaseId: gate.leaseId })
      if (boundaryDenied) return JSON.stringify(boundaryDenied)
      correlationId = gate.service.beginAgentAction(gate.surface)
      return null
    },
    end: () => {
      if (correlationId) gate.service.endAgentAction(gate.surface, correlationId)
      correlationId = null
    },
  }
}
