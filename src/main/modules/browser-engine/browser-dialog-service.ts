import type { BrowserCdpEvent } from './cdp-session-service'

export interface BrowserDialogSnapshot {
  tabId: string
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload'
  message: string
  defaultPrompt?: string
  url?: string
}

interface BrowserDialogCdpPort {
  sendCommand(tabId: string | null, method: string, params?: Record<string, unknown>): Promise<unknown>
  subscribe(tabId: string | null, handler: (event: BrowserCdpEvent) => void): () => void
}

export class BrowserDialogService {
  private readonly pendingByTab = new Map<string, BrowserDialogSnapshot>()
  private readonly unsubscribeByTab = new Map<string, () => void>()
  private readonly readyByTab = new Map<string, Promise<void>>()

  constructor(
    private readonly cdp: BrowserDialogCdpPort,
    private readonly onPendingChange?: (tabId: string) => void,
  ) {}

  async ensure(tabId: string): Promise<void> {
    const pending = this.readyByTab.get(tabId)
    if (pending) return pending
    const unsubscribe = this.cdp.subscribe(tabId, (event) => this.onEvent(event))
    this.unsubscribeByTab.set(tabId, unsubscribe)
    const ready = Promise.resolve().then(() => this.cdp.sendCommand(tabId, 'Page.enable')).then(() => undefined).catch(error => {
      if (this.unsubscribeByTab.get(tabId) === unsubscribe) this.clear(tabId)
      throw error
    })
    this.readyByTab.set(tabId, ready)
    return ready
  }

  get(tabId: string): BrowserDialogSnapshot | null {
    return this.pendingByTab.get(tabId) || null
  }

  async handle(tabId: string, params: { accept: boolean; promptText?: string }): Promise<void> {
    await this.ensure(tabId)
    await this.cdp.sendCommand(tabId, 'Page.handleJavaScriptDialog', {
      accept: params.accept,
      ...(typeof params.promptText === 'string' ? { promptText: params.promptText } : {}),
    })
    this.pendingByTab.delete(tabId)
    this.onPendingChange?.(tabId)
  }

  hasPending(tabId: string): boolean {
    return this.pendingByTab.has(tabId)
  }

  clear(tabId: string): void {
    const hadPending = this.pendingByTab.delete(tabId)
    this.unsubscribeByTab.get(tabId)?.()
    this.unsubscribeByTab.delete(tabId)
    this.readyByTab.delete(tabId)
    if (hadPending) this.onPendingChange?.(tabId)
  }

  private onEvent(event: BrowserCdpEvent): void {
    if (event.method === 'Page.javascriptDialogClosed') {
      if (this.pendingByTab.delete(event.tabId)) this.onPendingChange?.(event.tabId)
      return
    }
    if (event.method !== 'Page.javascriptDialogOpening') return
    const rawType = String(event.params.type || 'alert')
    const type: BrowserDialogSnapshot['type'] = ['alert', 'confirm', 'prompt', 'beforeunload'].includes(rawType)
      ? rawType as BrowserDialogSnapshot['type']
      : 'alert'
    this.pendingByTab.set(event.tabId, {
      tabId: event.tabId,
      type,
      message: String(event.params.message || ''),
      ...(typeof event.params.url === 'string' ? { url: event.params.url } : {}),
      ...(typeof event.params.defaultPrompt === 'string' ? { defaultPrompt: event.params.defaultPrompt } : {}),
    })
    this.onPendingChange?.(event.tabId)
  }
}
