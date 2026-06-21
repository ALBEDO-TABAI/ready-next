import type { AgentBrowserSurface } from './agent-browser-errors'
import type { BrowserWriteLeaseService } from './browser-write-lease'
import type { BrowserLeaseSupervisionSnapshot, BrowserLeaseSurfaceSnapshot } from './ipc-supervision'

const SURFACES: AgentBrowserSurface[] = ['user-view', 'agent-view']

export function buildBrowserLeaseSupervisionSnapshot(
  service: BrowserWriteLeaseService,
): BrowserLeaseSupervisionSnapshot {
  const snapshot = (surface: AgentBrowserSurface): BrowserLeaseSurfaceSnapshot => {
    const lease = service.getLease(surface)
    return {
      surface,
      state: service.getState(surface),
      heldBy: lease?.taskId ?? null,
      runId: lease?.runId ?? null,
      tabId: lease?.tabId ?? null,
      leaseId: lease?.leaseId ?? null,
    }
  }
  const surfaces = {
    'user-view': snapshot('user-view'),
    'agent-view': snapshot('agent-view'),
  }
  const activeWriteSurface = SURFACES.find((surface) => surfaces[surface].state === 'held') ?? null
  return { surfaces, activeWriteSurface }
}
