import { NetworkIdleTracker } from './network-idle-tracker'
import type { BrowserHostView } from './host-types'
import type { BrowserCDPErrorCode } from './automation-types'

interface BrowserCdpTabRecord {
  id: string
  view?: BrowserHostView
}

interface BrowserCdpHost {
  resolveTabView(tabId: string | null): { tabId: string; tab: BrowserCdpTabRecord; view: BrowserHostView }
  createBrowserError: (code: BrowserCDPErrorCode, message: string) => Error
  captureInputGuard?: (tabId: string | null, method: string) => (() => void) | undefined
}

export interface BrowserCdpEvent {
  tabId: string
  method: string
  params: Record<string, unknown>
}

export interface BrowserCdpCommandOptions {
  beforeSend?: () => void
  timeoutMs?: number
  signal?: AbortSignal
}

type BrowserCdpEventHandler = (event: BrowserCdpEvent) => void
type BrowserDebuggerMessageListener = (
  event: Electron.Event,
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string,
) => void

export class BrowserCdpSessionService {
  private readonly domainRefsByTab = new Map<string, Map<string, number>>()
  private readonly attachedByService = new Set<string>()
  private readonly subscribersByTab = new Map<string, Set<BrowserDebuggerMessageListener>>()
  private readonly inFlightCommandsByTab = new Map<string, number>()
  private readonly attachmentRefsByTab = new Map<string, number>()

  private readonly idleTrackers = new Map<string, Promise<NetworkIdleTracker>>()

  async networkInFlight(tabId: string | null): Promise<number> {
    const resolved = this.host.resolveTabView(tabId).tabId
    await this.ensureNetworkTracking(resolved)
    return (await this.idleTrackers.get(resolved)!).inFlight()
  }

  async ensureNetworkTracking(tabId: string): Promise<void> {
    let pending = this.idleTrackers.get(tabId)
    if (!pending) {
      pending = (async () => {
        const tracker = new NetworkIdleTracker()
        const unsubscribe = this.subscribe(tabId, event => tracker.record(event))
        try { await this.retainDomain(tabId, 'Network') } catch (error) {
          unsubscribe()
          this.idleTrackers.delete(tabId)
          throw error
        }
        return tracker
      })()
      this.idleTrackers.set(tabId, pending)
    }
    await pending
  }

  constructor(private readonly host: BrowserCdpHost) {}

  async ensureAttached(tabId: string | null): Promise<{ tabId: string; view: BrowserHostView }> {
    const { tabId: resolvedTabId, view } = this.host.resolveTabView(tabId)
    try {
      if (!view.webContents.debugger.isAttached()) {
        view.webContents.debugger.attach('1.3')
        this.attachedByService.add(resolvedTabId)
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
    options?: BrowserCdpCommandOptions,
  ): Promise<unknown> {
    const inputGuard = this.host.captureInputGuard?.(tabId, method)
    const { tabId: resolvedTabId, view } = await this.ensureAttached(tabId)
    const timeoutMs = Math.max(1, Math.floor(options?.timeoutMs || 15_000))
    const controller = new AbortController()
    const abortFromExternal = () => controller.abort(options?.signal?.reason || new Error(`browser_cdp:${method}:aborted`))
    if (options?.signal?.aborted) abortFromExternal()
    else options?.signal?.addEventListener('abort', abortFromExternal, { once: true })
    let timer: ReturnType<typeof setTimeout> | null = null
    let operation: Promise<unknown> | null = null
    this.inFlightCommandsByTab.set(resolvedTabId, (this.inFlightCommandsByTab.get(resolvedTabId) ?? 0) + 1)
    try {
      inputGuard?.()
      options?.beforeSend?.()
      operation = view.webContents.debugger.sendCommand(method, params)
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          const stop = async () => {
            try {
              if (/^Runtime\.(?:evaluate|callFunctionOn)$/i.test(method)) {
                await view.webContents.debugger.sendCommand('Runtime.terminateExecution')
              } else if (/^Page\.(?:navigate|reload)$/i.test(method)) {
                await view.webContents.debugger.sendCommand('Page.stopLoading')
              }
            } catch {
              // The target may already be gone; the original abort still wins.
            }
            reject(controller.signal.reason instanceof Error
              ? controller.signal.reason
              : new Error(`browser_cdp:${method}:aborted`))
          }
          controller.signal.addEventListener('abort', () => { void stop() }, { once: true })
          if (controller.signal.aborted) void stop()
          else timer = setTimeout(() => {
            controller.abort(new Error(`browser_cdp:${method}:deadline_exceeded:${timeoutMs}`))
          }, timeoutMs)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
      options?.signal?.removeEventListener('abort', abortFromExternal)
      if (operation) void operation.catch(() => undefined)
      const remaining = Math.max(0, (this.inFlightCommandsByTab.get(resolvedTabId) ?? 1) - 1)
      if (remaining > 0) this.inFlightCommandsByTab.set(resolvedTabId, remaining)
      else this.inFlightCommandsByTab.delete(resolvedTabId)
      this.maybeDetach(resolvedTabId, view)
    }
  }

  async retainAttachment(tabId: string | null): Promise<() => void> {
    const { tabId: resolvedTabId, view } = await this.ensureAttached(tabId)
    this.attachmentRefsByTab.set(resolvedTabId, (this.attachmentRefsByTab.get(resolvedTabId) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const remaining = Math.max(0, (this.attachmentRefsByTab.get(resolvedTabId) ?? 1) - 1)
      if (remaining > 0) this.attachmentRefsByTab.set(resolvedTabId, remaining)
      else this.attachmentRefsByTab.delete(resolvedTabId)
      this.maybeDetach(resolvedTabId, view)
    }
  }

  subscribe(tabId: string | null, handler: BrowserCdpEventHandler): () => void {
    const { tabId: resolvedTabId, view } = this.host.resolveTabView(tabId)
    const listener: BrowserDebuggerMessageListener = (_event, method, params) => {
      handler({ tabId: resolvedTabId, method, params: params || {} })
    }
    view.webContents.debugger.on('message', listener)
    const subscribers = this.subscribersByTab.get(resolvedTabId) ?? new Set()
    subscribers.add(listener)
    this.subscribersByTab.set(resolvedTabId, subscribers)
    return () => {
      view.webContents.debugger.removeListener('message', listener)
      const latest = this.subscribersByTab.get(resolvedTabId)
      latest?.delete(listener)
      if (latest?.size === 0) this.subscribersByTab.delete(resolvedTabId)
      this.maybeDetach(resolvedTabId, view)
    }
  }

  async retainDomain(
    tabId: string | null,
    domain: string,
    enableParams?: Record<string, unknown>,
  ): Promise<() => Promise<void>> {
    const { tabId: resolvedTabId, view } = await this.ensureAttached(tabId)
    const refs = this.domainRefsByTab.get(resolvedTabId) || new Map<string, number>()
    const current = refs.get(domain) || 0
    refs.set(domain, current + 1)
    this.domainRefsByTab.set(resolvedTabId, refs)
    if (current === 0) {
      try {
        await this.sendCommand(resolvedTabId, `${domain}.enable`, enableParams)
      } catch (error) {
        refs.delete(domain)
        if (refs.size === 0) this.domainRefsByTab.delete(resolvedTabId)
        this.maybeDetach(resolvedTabId, view)
        throw error
      }
    }

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
      this.maybeDetach(resolvedTabId)
    }
  }

  disposeTab(tabId: string): void {
    this.idleTrackers.delete(tabId)
    let view: BrowserHostView | null = null
    try {
      view = this.host.resolveTabView(tabId).view
    } catch {
      // Tab teardown can race renderer destruction.
    }
    if (view) {
      for (const listener of this.subscribersByTab.get(tabId) ?? []) {
        try {
          view.webContents.debugger.removeListener('message', listener)
        } catch {
          // Ignore teardown races.
        }
      }
    }
    this.subscribersByTab.delete(tabId)
    this.domainRefsByTab.delete(tabId)
    this.attachmentRefsByTab.delete(tabId)
    this.inFlightCommandsByTab.delete(tabId)
    this.maybeDetach(tabId, view ?? undefined, true)
  }

  private maybeDetach(tabId: string, knownView?: BrowserHostView, force = false): void {
    if (!this.attachedByService.has(tabId)) return
    if (!force && (
      (this.domainRefsByTab.get(tabId)?.size ?? 0) > 0
      || (this.attachmentRefsByTab.get(tabId) ?? 0) > 0
      || (this.subscribersByTab.get(tabId)?.size ?? 0) > 0
      || (this.inFlightCommandsByTab.get(tabId) ?? 0) > 0
    )) return
    let view = knownView
    if (!view) {
      try {
        view = this.host.resolveTabView(tabId).view
      } catch {
        this.attachedByService.delete(tabId)
        return
      }
    }
    try {
      if (view.webContents.debugger.isAttached()) view.webContents.debugger.detach()
    } catch {
      // The renderer may already be gone.
    }
    this.attachedByService.delete(tabId)
  }
}
