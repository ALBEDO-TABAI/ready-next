import type { BrowserHostView } from './host-types'
import type { BrowserCDPErrorCode } from './automation-types'

interface BrowserCdpTabRecord {
  id: string
  view?: BrowserHostView
}

interface BrowserCdpHost {
  resolveTabView(tabId: string | null): { tabId: string; tab: BrowserCdpTabRecord; view: BrowserHostView }
  createBrowserError: (code: BrowserCDPErrorCode, message: string) => Error
}

export interface BrowserCdpEvent {
  tabId: string
  method: string
  params: Record<string, unknown>
}

type BrowserCdpEventHandler = (event: BrowserCdpEvent) => void

export class BrowserCdpSessionService {
  private readonly domainRefsByTab = new Map<string, Map<string, number>>()

  constructor(private readonly host: BrowserCdpHost) {}

  async ensureAttached(tabId: string | null): Promise<{ tabId: string; view: BrowserHostView }> {
    const { tabId: resolvedTabId, view } = this.host.resolveTabView(tabId)
    try {
      if (!view.webContents.debugger.isAttached()) {
        view.webContents.debugger.attach('1.3')
      }
      return { tabId: resolvedTabId, view }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw this.host.createBrowserError('DEBUGGER_ATTACH_FAILED', `Debugger attach failed: ${message}`)
    }
  }

  async sendCommand(
    tabId: string | null,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    const { view } = await this.ensureAttached(tabId)
    return view.webContents.debugger.sendCommand(method, params)
  }

  subscribe(tabId: string | null, handler: BrowserCdpEventHandler): () => void {
    const { tabId: resolvedTabId, view } = this.host.resolveTabView(tabId)
    const listener = (_event: unknown, method: string, params?: Record<string, unknown>) => {
      handler({ tabId: resolvedTabId, method, params: params || {} })
    }
    view.webContents.debugger.on('message', listener)
    return () => {
      view.webContents.debugger.removeListener('message', listener)
    }
  }

  async retainDomain(
    tabId: string | null,
    domain: string,
    enableParams?: Record<string, unknown>,
  ): Promise<() => Promise<void>> {
    const { tabId: resolvedTabId } = await this.ensureAttached(tabId)
    const refs = this.domainRefsByTab.get(resolvedTabId) || new Map<string, number>()
    const current = refs.get(domain) || 0
    if (current === 0) {
      await this.sendCommand(resolvedTabId, `${domain}.enable`, enableParams)
    }
    refs.set(domain, current + 1)
    this.domainRefsByTab.set(resolvedTabId, refs)

    let released = false
    return async () => {
      if (released) return
      released = true
      const latestRefs = this.domainRefsByTab.get(resolvedTabId)
      if (!latestRefs) return
      const next = Math.max(0, (latestRefs.get(domain) || 0) - 1)
      if (next > 0) {
        latestRefs.set(domain, next)
        return
      }
      latestRefs.delete(domain)
      if (latestRefs.size === 0) this.domainRefsByTab.delete(resolvedTabId)
      try {
        await this.sendCommand(resolvedTabId, `${domain}.disable`)
      } catch {
        // A tab may be gone by cleanup time; observer teardown must not fail the caller.
      }
    }
  }
}
