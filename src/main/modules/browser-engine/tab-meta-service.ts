export interface BrowserTabMetaRecord {
  id: string
  url: string
  title: string
  domain: string
  favicon: string | null
  owner: string
  required: boolean
  activity: string
  lastAuditedAt: number | null
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  error: string | null
}

export interface BrowserTabMetaPayload {
  id: string
  url: string
  title: string
  domain: string
  favicon: string | null
  owner: string
  required: boolean
  activity: string
  lastAuditedAt: number | null
  active: boolean
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  error: string | null
}

interface BrowserTabMetaServiceDeps<TTab extends BrowserTabMetaRecord> {
  tabs: Map<string, TTab>
  getActiveTabId(): string | null
  sendToRenderer: (channel: string, data: unknown) => void
}

export class BrowserTabMetaService<TTab extends BrowserTabMetaRecord> {
  constructor(private readonly deps: BrowserTabMetaServiceDeps<TTab>) {}

  buildTabPayload(tab: TTab): BrowserTabMetaPayload {
    return {
      id: tab.id,
      url: tab.url,
      title: tab.title,
      domain: tab.domain,
      favicon: tab.favicon,
      owner: tab.owner,
      required: tab.required,
      activity: tab.activity,
      lastAuditedAt: tab.lastAuditedAt,
      active: tab.id === this.deps.getActiveTabId(),
      loading: tab.loading,
      canGoBack: tab.canGoBack,
      canGoForward: tab.canGoForward,
      error: tab.error,
    }
  }

  emitTabMeta(tabId: string): void {
    const tab = this.deps.tabs.get(tabId)
    if (!tab) return
    this.deps.sendToRenderer('browser:tabUpdate', {
      type: 'meta',
      tabId,
      ...this.buildTabPayload(tab),
    })
  }

  getTabList(): BrowserTabMetaPayload[] {
    return Array.from(this.deps.tabs.values()).map((tab) => this.buildTabPayload(tab))
  }
}
