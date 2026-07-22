import { resolveBrowserCapability } from '../../../shared/browser-capability-registry'
import { isAgentBrowserError } from './agent-browser-errors'
import type { AgentBrowserSurface } from './agent-browser-errors'
import type {
  BrowserTargetClaimIdentity,
  BrowserTargetClaimService,
} from './browser-target-claims'

export interface BrowserTargetClaimGate {
  service: BrowserTargetClaimService
  identity: BrowserTargetClaimIdentity
  surface: AgentBrowserSurface
}

export interface TargetClaimGateHandle {
  deniedMessage: string | null
  begin: () => string | null
  end: () => void
}

const NOOP = () => {}

export function beginTargetClaimGate(
  gate: BrowserTargetClaimGate | undefined,
  toolName: string,
  args: Record<string, unknown>,
): TargetClaimGateHandle {
  if (!gate) return { deniedMessage: null, begin: () => null, end: NOOP }

  const capability = resolveBrowserCapability(toolName, args)
  if (!capability?.requiresPageLease) return { deniedMessage: null, begin: () => null, end: NOOP }

  const denied = gate.service.checkWrite(gate.identity)
  if (denied && isAgentBrowserError(denied)) {
    return { deniedMessage: JSON.stringify(denied), begin: () => JSON.stringify(denied), end: NOOP }
  }

  let correlationId: string | null = null
  return {
    deniedMessage: null,
    begin: () => {
      const boundaryDenied = gate.service.checkWrite(gate.identity)
      if (boundaryDenied) return JSON.stringify(boundaryDenied)
      if (correlationId) return null
      const started = gate.service.beginAgentAction(gate.identity)
      if (isAgentBrowserError(started)) return JSON.stringify(started)
      correlationId = started
      return null
    },
    end: () => {
      if (correlationId) gate.service.endAgentAction(gate.identity, correlationId)
      correlationId = null
    },
  }
}
