import { randomUUID } from 'node:crypto'
import { BrowserCdpSessionService, type BrowserCdpEvent } from './cdp-session-service'

export interface BrowserNetworkEventRecord {
  requestId: string
  url: string
  method?: string
  status?: number
  mimeType?: string
  resourceType?: string
  initiatorType?: string
  responseHeaders?: Record<string, string>
  startedAt?: number
  finishedAt?: number
  failed?: boolean
  errorText?: string
}

export interface BrowserNetworkObserverOptions {
  maxEvents?: number
}

export interface BrowserNetworkResponseBody {
  body: string
  base64Encoded: boolean
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function numberField(value: unknown): number | undefined {
  const next = Number(value)
  return Number.isFinite(next) ? next : undefined
}

function headersRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object') return undefined
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const name = key.trim()
    if (!name) continue
    out[name] = String(raw ?? '')
  }
  return Object.keys(out).length > 0 ? out : undefined
}

export class BrowserNetworkObserverHandle {
  readonly id = `network-observer-${randomUUID()}`
  private readonly recordsByRequestId = new Map<string, BrowserNetworkEventRecord>()
  private readonly requestOrder: string[] = []
  private stopped = false
  private releaseNetwork: (() => Promise<void>) | null = null
  private unsubscribe: (() => void) | null = null

  constructor(
    private readonly cdp: BrowserCdpSessionService,
    readonly tabId: string,
    private readonly options: Required<BrowserNetworkObserverOptions>,
    private readonly onStopped?: (handle: BrowserNetworkObserverHandle) => void,
  ) {}

  async start(): Promise<void> {
    this.releaseNetwork = await this.cdp.retainDomain(this.tabId, 'Network')
    this.unsubscribe = this.cdp.subscribe(this.tabId, (event) => this.record(event))
  }

  events(): BrowserNetworkEventRecord[] {
    return this.requestOrder
      .map((requestId) => this.recordsByRequestId.get(requestId))
      .filter((record): record is BrowserNetworkEventRecord => Boolean(record))
  }

  async getResponseBody(requestId: string): Promise<BrowserNetworkResponseBody> {
    const result = await this.cdp.sendCommand(this.tabId, 'Network.getResponseBody', { requestId }) as {
      body?: string
      base64Encoded?: boolean
    }
    return {
      body: String(result?.body || ''),
      base64Encoded: result?.base64Encoded === true,
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.unsubscribe?.()
    this.unsubscribe = null
    const releaseNetwork = this.releaseNetwork
    this.releaseNetwork = null
    await releaseNetwork?.()
    this.onStopped?.(this)
  }

  private ensureRecord(requestId: string): BrowserNetworkEventRecord {
    let record = this.recordsByRequestId.get(requestId)
    if (record) return record
    record = { requestId, url: '' }
    this.recordsByRequestId.set(requestId, record)
    this.requestOrder.push(requestId)
    while (this.requestOrder.length > this.options.maxEvents) {
      const removed = this.requestOrder.shift()
      if (removed) this.recordsByRequestId.delete(removed)
    }
    return record
  }

  private record(event: BrowserCdpEvent): void {
    if (this.stopped) return
    const requestId = stringField(event.params.requestId)
    if (!requestId) return

    if (event.method === 'Network.requestWillBeSent') {
      const request = event.params.request && typeof event.params.request === 'object'
        ? event.params.request as Record<string, unknown>
        : {}
      const initiator = event.params.initiator && typeof event.params.initiator === 'object'
        ? event.params.initiator as Record<string, unknown>
        : {}
      const record = this.ensureRecord(requestId)
      record.url = stringField(request.url) || record.url
      record.method = stringField(request.method) || record.method
      record.resourceType = stringField(event.params.type) || record.resourceType
      record.initiatorType = stringField(initiator.type) || record.initiatorType
      record.startedAt = numberField(event.params.timestamp) ?? record.startedAt
      return
    }

    if (event.method === 'Network.responseReceived') {
      const response = event.params.response && typeof event.params.response === 'object'
        ? event.params.response as Record<string, unknown>
        : {}
      const record = this.ensureRecord(requestId)
      record.url = stringField(response.url) || record.url
      record.status = numberField(response.status) ?? record.status
      record.mimeType = stringField(response.mimeType) || record.mimeType
      record.resourceType = stringField(event.params.type) || record.resourceType
      record.responseHeaders = headersRecord(response.headers) || record.responseHeaders
      return
    }

    if (event.method === 'Network.loadingFinished') {
      const record = this.ensureRecord(requestId)
      record.finishedAt = numberField(event.params.timestamp) ?? record.finishedAt
      return
    }

    if (event.method === 'Network.loadingFailed') {
      const record = this.ensureRecord(requestId)
      record.finishedAt = numberField(event.params.timestamp) ?? record.finishedAt
      record.failed = true
      record.errorText = stringField(event.params.errorText) || record.errorText
    }
  }
}

export class BrowserNetworkObserverService {
  private readonly handlesByTab = new Map<string, Set<BrowserNetworkObserverHandle>>()

  constructor(private readonly cdp: BrowserCdpSessionService) {}

  async start(
    tabId: string,
    options: BrowserNetworkObserverOptions = {},
  ): Promise<BrowserNetworkObserverHandle> {
    const handle = new BrowserNetworkObserverHandle(
      this.cdp,
      tabId,
      { maxEvents: Math.max(1, Math.min(500, Math.floor(options.maxEvents || 120))) },
      (stopped) => {
        const handles = this.handlesByTab.get(tabId)
        handles?.delete(stopped)
        if (handles?.size === 0) this.handlesByTab.delete(tabId)
      },
    )
    await handle.start()
    const handles = this.handlesByTab.get(tabId) ?? new Set()
    handles.add(handle)
    this.handlesByTab.set(tabId, handles)
    return handle
  }

  disposeTab(tabId: string): void {
    const handles = [...(this.handlesByTab.get(tabId) ?? [])]
    this.handlesByTab.delete(tabId)
    for (const handle of handles) void handle.stop().catch(() => undefined)
  }
}
